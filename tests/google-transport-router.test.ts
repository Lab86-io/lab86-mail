import { afterEach, describe, expect, test } from 'bun:test';
import {
  __setGoogleHttpDepsForTest,
  GOOGLE_MAX_RETRY_AFTER_MS,
  GoogleApiError,
  googleFetch,
  googleJson,
  googleUrl,
} from '../lib/google/http';
import { isGoogleDirectEnabled, isGoogleDirectGrant, newGoogleDirectGrantId } from '../lib/google/transport';
import { routeNylasClient } from '../lib/nylas/client';

describe('direct Google grant ids', () => {
  test('each connection gets a new random id that does not hold the account id', () => {
    const first = newGoogleDirectGrantId();
    const second = newGoogleDirectGrantId();
    expect(first).toMatch(/^google:[0-9a-f-]{36}$/);
    expect(first).not.toBe(second);
    expect(isGoogleDirectGrant(first)).toBe(true);
    expect(newGoogleDirectGrantId(() => 'fixed')).toBe('google:fixed');
  });

  test('reject Nylas grants and empty values', () => {
    expect(isGoogleDirectGrant('d502cbfc-98b3-49f4-93a7-d0a5d825d7fa')).toBe(false);
    expect(isGoogleDirectGrant('google:')).toBe(false);
    expect(isGoogleDirectGrant(undefined)).toBe(false);
    expect(() => newGoogleDirectGrantId(() => ' ')).toThrow();
  });

  test('the flag is off unless it is exactly 1', () => {
    expect(isGoogleDirectEnabled({})).toBe(false);
    expect(isGoogleDirectEnabled({ LAB86_GOOGLE_DIRECT: 'true' })).toBe(false);
    expect(isGoogleDirectEnabled({ LAB86_GOOGLE_DIRECT: '1' })).toBe(true);
  });
});

describe('routeNylasClient', () => {
  const calls: string[] = [];
  const real = {
    messages: {
      list: async (args: any) => {
        calls.push(`nylas:${args.identifier}`);
        return { data: ['nylas'] };
      },
      find: async (args: any) => {
        calls.push(`nylas-find:${args.identifier}`);
        return { data: 'nylas' };
      },
    },
    grants: {
      destroy: async (args: any) => {
        calls.push(`nylas-destroy:${args.grantId}`);
        return { requestId: 'r' };
      },
    },
    auth: { urlForOAuth2: () => 'https://nylas.example.test/auth' },
  };
  const adapter = {
    messages: {
      list: async (args: any) => {
        calls.push(`google:${args.identifier}`);
        return { data: ['google'] };
      },
    },
    grants: {
      destroy: async (args: any) => {
        calls.push(`google-destroy:${args.grantId}`);
        return { requestId: 'g' };
      },
    },
  };
  const client = routeNylasClient(real, adapter);

  afterEach(() => {
    calls.length = 0;
  });

  test('sends a direct Google grant to the adapter', async () => {
    expect(await client.messages.list({ identifier: 'google:acct-1' })).toEqual({ data: ['google'] });
    expect(calls).toEqual(['google:google:acct-1']);
  });

  test('sends a Nylas grant to Nylas', async () => {
    expect(await client.messages.list({ identifier: 'grant-1' })).toEqual({ data: ['nylas'] });
    expect(calls).toEqual(['nylas:grant-1']);
  });

  test('routes grants.destroy by grantId', async () => {
    await client.grants.destroy({ grantId: 'google:acct-2' });
    await client.grants.destroy({ grantId: 'grant-2' });
    expect(calls).toEqual(['google-destroy:google:acct-2', 'nylas-destroy:grant-2']);
  });

  test('rejects a method the adapter does not have with a 501', async () => {
    const error = await client.messages.find({ identifier: 'google:acct-1' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoogleApiError);
    expect((error as GoogleApiError).statusCode).toBe(501);
    expect(calls).toEqual([]);
  });

  test('leaves resources that are not routed alone', () => {
    expect(client.auth.urlForOAuth2()).toBe('https://nylas.example.test/auth');
  });
});

describe('googleFetch', () => {
  afterEach(() => __setGoogleHttpDepsForTest());

  function responder(statuses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
    const seen: Array<{ url: string; auth: string | null; body: unknown }> = [];
    let index = 0;
    const fetch = async (url: string, init?: RequestInit) => {
      const next = statuses[Math.min(index, statuses.length - 1)];
      index += 1;
      seen.push({ url, auth: new Headers(init?.headers).get('authorization'), body: init?.body });
      return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
        status: next.status,
        headers: next.headers,
      });
    };
    return { fetch, seen };
  }

  test('sends the bearer token and a JSON body', async () => {
    const { fetch, seen } = responder([{ status: 200, body: { id: 'm1' } }]);
    __setGoogleHttpDepsForTest({ fetch, getGoogleAccessToken: async () => 'tok', sleep: async () => {} });
    expect(
      await googleJson<{ id: string }>('google:a', 'https://x.test/m', { method: 'POST', json: { a: 1 } }),
    ).toEqual({
      id: 'm1',
    });
    expect(seen[0].auth).toBe('Bearer tok');
    expect(seen[0].body).toBe('{"a":1}');
  });

  test('refreshes the token one time on 401', async () => {
    const { fetch, seen } = responder([{ status: 401 }, { status: 200, body: {} }]);
    let invalidated = 0;
    let token = 0;
    __setGoogleHttpDepsForTest({
      fetch,
      getGoogleAccessToken: async () => `tok${++token}`,
      invalidateGoogleAccessToken: () => {
        invalidated += 1;
      },
      sleep: async () => {},
    });
    await googleFetch('google:a', 'https://x.test');
    expect(invalidated).toBe(1);
    expect(seen.map((s) => s.auth)).toEqual(['Bearer tok1', 'Bearer tok2']);
  });

  test('retries 429 and 5xx, then throws with the status', async () => {
    const { fetch, seen } = responder([
      { status: 429, headers: { 'retry-after': '1' } },
      { status: 503, body: { error: { message: 'Backend Error', errors: [{ reason: 'backendError' }] } } },
    ]);
    const waits: number[] = [];
    __setGoogleHttpDepsForTest({
      fetch,
      getGoogleAccessToken: async () => 'tok',
      sleep: async (ms: number) => {
        waits.push(ms);
      },
    });
    const error = (await googleFetch('google:a', 'https://x.test', { attempts: 3 }).catch(
      (e: unknown) => e,
    )) as GoogleApiError;
    expect(error).toBeInstanceOf(GoogleApiError);
    expect(error.statusCode).toBe(503);
    expect(error.reason).toBe('backendError');
    expect(error.message).toBe('Backend Error');
    expect(seen).toHaveLength(3);
    expect(waits[0]).toBe(1000);
  });

  test('does not retry a 404 and keeps an OAuth error string', async () => {
    const { fetch, seen } = responder([
      { status: 400, body: { error: 'invalid_grant', error_description: 'Bad' } },
    ]);
    __setGoogleHttpDepsForTest({ fetch, getGoogleAccessToken: async () => 'tok', sleep: async () => {} });
    const error = (await googleFetch('google:a', 'https://x.test').catch(
      (e: unknown) => e,
    )) as GoogleApiError;
    expect(error.statusCode).toBe(400);
    expect(error.reason).toBe('invalid_grant');
    expect(error.message).toBe('Bad');
    expect(seen).toHaveLength(1);
  });

  test('retries a rate-limit 403 and reports it as 429 at the end', async () => {
    const limited = {
      error: { message: 'Rate Limit Exceeded', errors: [{ reason: 'userRateLimitExceeded' }] },
    };
    const { fetch, seen } = responder([{ status: 403, body: limited }]);
    __setGoogleHttpDepsForTest({ fetch, getGoogleAccessToken: async () => 'tok', sleep: async () => {} });
    const error = (await googleFetch('google:a', 'https://x.test', { attempts: 2 }).catch(
      (e: unknown) => e,
    )) as GoogleApiError;
    expect(error.statusCode).toBe(429);
    expect(error.reason).toBe('userRateLimitExceeded');
    expect(seen).toHaveLength(2);
  });

  test('a rate-limit 403 that clears on retry returns the answer', async () => {
    const limited = { error: { message: 'Rate Limit Exceeded', errors: [{ reason: 'rateLimitExceeded' }] } };
    const { fetch, seen } = responder([
      { status: 403, body: limited },
      { status: 200, body: { ok: true } },
    ]);
    __setGoogleHttpDepsForTest({ fetch, getGoogleAccessToken: async () => 'tok', sleep: async () => {} });
    expect(await googleJson<{ ok: boolean }>('google:a', 'https://x.test')).toEqual({ ok: true });
    expect(seen).toHaveLength(2);
  });

  test('a scope 403 is not retried and keeps its status', async () => {
    const denied = {
      error: { message: 'Insufficient Permission', errors: [{ reason: 'insufficientPermissions' }] },
    };
    const { fetch, seen } = responder([{ status: 403, body: denied }]);
    __setGoogleHttpDepsForTest({ fetch, getGoogleAccessToken: async () => 'tok', sleep: async () => {} });
    const error = (await googleFetch('google:a', 'https://x.test').catch(
      (e: unknown) => e,
    )) as GoogleApiError;
    expect(error.statusCode).toBe(403);
    expect(seen).toHaveLength(1);
  });

  test('a request that hangs stops at its time limit; a signal of the caller is kept', async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    const hang = async (_url: string, init?: RequestInit) => {
      signals.push(init?.signal);
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    };
    __setGoogleHttpDepsForTest({
      fetch: hang,
      getGoogleAccessToken: async () => 'tok',
      sleep: async () => {},
    });
    const error = (await googleFetch('google:a', 'https://x.test', { timeoutMs: 5 }).catch(
      (e: unknown) => e,
    )) as Error;
    expect(error.name).toBe('TimeoutError');
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    const own = new AbortController();
    const pending = googleFetch('google:a', 'https://x.test', { signal: own.signal, timeoutMs: 1 }).catch(
      (e: unknown) => e,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The caller's signal replaces the time limit: the request still waits.
    expect(signals[1]).toBe(own.signal);
    own.abort(new Error('stopped by the caller'));
    expect(((await pending) as Error).message).toBe('stopped by the caller');
  });

  test('a long Retry-After waits at most the cap', async () => {
    const { fetch } = responder([{ status: 429, headers: { 'retry-after': '3600' } }, { status: 200 }]);
    const waits: number[] = [];
    __setGoogleHttpDepsForTest({
      fetch,
      getGoogleAccessToken: async () => 'tok',
      sleep: async (ms: number) => {
        waits.push(ms);
      },
    });
    await googleFetch('google:a', 'https://x.test');
    expect(waits).toEqual([GOOGLE_MAX_RETRY_AFTER_MS]);
  });

  test('googleJson returns undefined for 204', async () => {
    const { fetch } = responder([{ status: 204 }]);
    __setGoogleHttpDepsForTest({ fetch, getGoogleAccessToken: async () => 'tok', sleep: async () => {} });
    expect(await googleJson('google:a', 'https://x.test')).toBeUndefined();
  });
});

describe('googleUrl', () => {
  test('skips empty values and repeats arrays', () => {
    const url = new URL(
      googleUrl('https://x.test/list', { q: 'in:inbox', pageToken: undefined, labelIds: ['A', 'B'] }),
    );
    expect(url.searchParams.get('q')).toBe('in:inbox');
    expect(url.searchParams.has('pageToken')).toBe(false);
    expect(url.searchParams.getAll('labelIds')).toEqual(['A', 'B']);
  });
});
