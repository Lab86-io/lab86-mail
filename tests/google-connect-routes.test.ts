import { describe, expect, mock, test } from 'bun:test';
import { NextRequest, NextResponse } from 'next/server';
import { createGoogleHistoryPost } from '../app/api/cron/google-history/route';
import { createCloudFileOAuthCallback } from '../app/api/files/oauth/callback/route';
import { createGoogleConnectGet } from '../app/api/google/connect/route';
import { createNylasConnectGet } from '../app/api/nylas/connect/route';
import { createNylasOAuthFinalize } from '../app/api/nylas/finalize/route';
import { AuthRequiredError } from '../lib/auth/current-user';
import { GoogleConnectError } from '../lib/google/connect';
import { RateLimitError } from '../lib/rate-limit';

const user = { userId: 'user-1', email: 'ann@example.com', name: 'Ann', source: 'clerk' as const };

describe('GET /api/google/connect', () => {
  function route(overrides: Record<string, unknown> = {}) {
    const starts: any[] = [];
    const get = createGoogleConnectGet({
      requireCurrentUser: async () => user,
      enforceUserRateLimit: async () => ({ ok: true }),
      startGoogleMailConnect: async (input: any) => {
        starts.push(input);
        return {
          authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=s',
          mode: input.mode,
          accountId: 'acct-1',
        };
      },
      ...overrides,
    } as any);
    return { get, starts };
  }

  test('a switch URL redirects to Google', async () => {
    const { get, starts } = route();
    const response = await get(
      new NextRequest(
        'https://mail-staging.lab86.io/api/google/connect?mode=switch&account=ann%40example.com',
        {
          headers: { host: 'mail-staging.lab86.io' },
        },
      ),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('accounts.google.com');
    expect(starts[0]).toMatchObject({
      userId: 'user-1',
      mode: 'switch',
      account: 'ann@example.com',
      native: false,
      host: 'mail-staging.lab86.io',
    });
  });

  test('the mode defaults from the account parameter; native JSON returns the URL', async () => {
    const { get, starts } = route();
    const json = await get(new NextRequest('http://localhost/api/google/connect?native=1&format=json'));
    expect(await json.json()).toEqual({
      ok: true,
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=s',
      mode: 'new',
    });
    expect(starts[0]).toMatchObject({ mode: 'new', native: true });
    await get(new NextRequest('http://localhost/api/google/connect?account=acct-1'));
    expect(starts[1].mode).toBe('switch');
  });

  test('errors: a bad mode, signed out, rate limit, refusal, and a crash', async () => {
    expect(
      (await route().get(new NextRequest('http://localhost/api/google/connect?mode=delete'))).status,
    ).toBe(400);
    const signedOut = route({
      requireCurrentUser: async () => {
        throw new AuthRequiredError('Sign in required.');
      },
    });
    expect((await signedOut.get(new NextRequest('http://localhost/api/google/connect'))).status).toBe(401);
    const limited = route({
      enforceUserRateLimit: async () => {
        throw new RateLimitError('slow down', 30, 10);
      },
    });
    expect((await limited.get(new NextRequest('http://localhost/api/google/connect'))).status).toBe(429);
    const refused = route({
      startGoogleMailConnect: async () => {
        throw new GoogleConnectError(403, 'Switching accounts to Gmail is off.');
      },
    });
    const refusal = await refused.get(
      new NextRequest('http://localhost/api/google/connect?mode=switch&account=x'),
    );
    expect(refusal.status).toBe(403);
    expect(await refusal.json()).toEqual({ ok: false, error: 'Switching accounts to Gmail is off.' });
    const crashed = route({
      startGoogleMailConnect: async () => {
        throw new Error('secret detail');
      },
    });
    const crash = await crashed.get(new NextRequest('http://localhost/api/google/connect'));
    expect(crash.status).toBe(500);
    expect(JSON.stringify(await crash.json())).not.toContain('secret');
  });
});

describe('POST /api/nylas/finalize with a Google completion', () => {
  const token = 'x'.repeat(43);
  function route(stored: unknown, overrides: Record<string, unknown> = {}) {
    const calls: any = { consumed: [], google: [], nylas: [] };
    const post = createNylasOAuthFinalize({
      requireCurrentUser: async () => user,
      enforceUserRateLimit: async () => ({ ok: true }),
      consumeOAuthCompletion: async (input: any) => {
        calls.consumed.push(input);
        return stored;
      },
      completeNylasConnection: async (input: any) => {
        calls.nylas.push(input);
        return {};
      },
      finalizeGoogleMailCompletion: async (input: any) => {
        calls.google.push(input);
        return { accountId: 'acct-1', grantId: 'google:acct-1', outcome: 'switched' };
      },
      ...overrides,
    } as any);
    return { post, calls };
  }
  const request = () =>
    new NextRequest('http://localhost/api/nylas/finalize', {
      method: 'POST',
      body: JSON.stringify({ completionToken: token }),
    });
  const google = { googleMail: { mode: 'switch', accountId: 'acct-1', code: 'c', codeVerifier: 'v' } };

  test('a Google payload goes to the Google completion, for the signed-in user', async () => {
    const { post, calls } = route(google);
    const response = await post(request());
    expect(await response.json()).toEqual({ ok: true, accountId: 'acct-1', outcome: 'switched' });
    expect(calls.consumed).toEqual([{ userId: 'user-1', kind: 'mail', completionToken: token }]);
    expect(calls.google).toEqual([{ userId: 'user-1', completion: google }]);
    expect(calls.nylas).toEqual([]);
  });

  test('a Nylas payload still goes to Nylas; a refusal keeps its status', async () => {
    const nylas = route({ code: 'nylas-code', provider: 'google' });
    expect(await (await nylas.post(request())).json()).toEqual({ ok: true });
    expect(nylas.calls.nylas).toEqual([{ userId: 'user-1', code: 'nylas-code', provider: 'google' }]);
    expect(nylas.calls.google).toEqual([]);
    const refused = route(google, {
      finalizeGoogleMailCompletion: async () => {
        throw new GoogleConnectError(409, 'Sign in to Google as ann@example.com.');
      },
    });
    const response = await refused.post(request());
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('Sign in to Google');
    expect((await route(null).post(request())).status).toBe(409);
  });
});

describe('the Files callback shares its redirect URI with Google mail', () => {
  test('a Google mail state is handled first, and the Files flow does not run', async () => {
    let filesConsumed = 0;
    const handler = createCloudFileOAuthCallback({
      handleGoogleMailCallback: async () =>
        NextResponse.redirect('https://mail.example/settings?nylas_connected=1'),
      consumeCloudFileOAuthState: async () => {
        filesConsumed += 1;
        return null;
      },
    } as any);
    const response = await handler(
      new NextRequest('http://localhost/api/files/oauth/callback?state=google-state&code=c'),
    );
    expect(response.headers.get('location')).toBe('https://mail.example/settings?nylas_connected=1');
    expect(filesConsumed).toBe(0);
  });

  test('any other state goes on to the Files flow unchanged', async () => {
    const seen: any[] = [];
    const handler = createCloudFileOAuthCallback({
      handleGoogleMailCallback: async (input: any) => {
        seen.push(input);
        return null;
      },
      consumeCloudFileOAuthState: async () => null,
    } as any);
    const response = await handler(
      new NextRequest(
        'http://localhost/api/files/oauth/callback?state=files-state&code=c&error=access_denied',
      ),
    );
    expect(seen).toEqual([{ state: 'files-state', code: 'c', providerError: 'access_denied' }]);
    expect(response.headers.get('location')).toContain('files_error=OAuth+state+is+invalid+or+expired');
  });
});

describe('the Nylas connect route with the direct Google flow', () => {
  function deps(choice: any, overrides: Record<string, unknown> = {}) {
    const calls: any = { starts: [], choices: [], nylasStates: 0 };
    return {
      calls,
      deps: {
        requireCurrentUser: async () => user,
        isNylasConfigured: () => true,
        enforceUserRateLimit: async () => ({ ok: true }),
        convexMutation: mock(async (_fn: unknown, args: any) => {
          if (args?.state) calls.nylasStates += 1;
          return { ok: true };
        }),
        requireNylas: () => ({ auth: { urlForOAuth2: () => 'https://nylas.example/authorize' } }),
        nylasRedirectUri: () => 'https://mail.example/api/nylas/callback',
        randomState: () => 'nylas-state',
        directGoogleConnectChoice: async (input: any) => {
          calls.choices.push(input);
          return choice;
        },
        startGoogleMailConnect: async (input: any) => {
          calls.starts.push(input);
          return {
            authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=g',
            mode: input.mode,
          };
        },
        ...overrides,
      },
    };
  }

  test('with a direct choice, Google goes to Gmail and no Nylas state is made', async () => {
    const { deps: d, calls } = deps({ mode: 'new' });
    const response = await createNylasConnectGet(d as any)(
      new NextRequest('http://localhost/api/nylas/connect?provider=google&native=1&format=json'),
    );
    expect(await response.json()).toEqual({
      ok: true,
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=g',
    });
    expect(calls.choices).toEqual([{ userId: 'user-1', account: null }]);
    expect(calls.starts[0]).toMatchObject({ userId: 'user-1', mode: 'new', native: true });
    expect(calls.nylasStates).toBe(0);
    const redirect = await createNylasConnectGet(d as any)(
      new NextRequest(
        'http://localhost/api/nylas/connect?provider=google&account=acct-2&redirectTo=%2Fsettings',
      ),
    );
    // The Settings Reconnect link names the account.
    expect(calls.choices[1]).toEqual({ userId: 'user-1', account: 'acct-2' });
    expect(redirect.headers.get('location')).toContain('accounts.google.com');
    expect(calls.starts[1].redirectTo).toBe('/settings');
  });

  test('without a choice, or for another provider, the Nylas flow runs', async () => {
    const { deps: d, calls } = deps(null);
    const google = await createNylasConnectGet(d as any)(
      new NextRequest('http://localhost/api/nylas/connect?provider=google&format=json'),
    );
    expect((await google.json()).authorizationUrl).toBe('https://nylas.example/authorize');
    const outlook = await createNylasConnectGet(d as any)(
      new NextRequest('http://localhost/api/nylas/connect?provider=microsoft&format=json'),
    );
    expect((await outlook.json()).authorizationUrl).toBe('https://nylas.example/authorize');
    expect(calls.choices).toHaveLength(1);
    expect(calls.starts).toHaveLength(0);
  });

  test('a refusal of the direct flow is a JSON error; other failures throw', async () => {
    const { deps: refused } = deps(
      { mode: 'reconnect', account: 'acct-2' },
      {
        startGoogleMailConnect: async () => {
          throw new GoogleConnectError(503, 'Google sign-in is not configured.');
        },
      },
    );
    const response = await createNylasConnectGet(refused as any)(
      new NextRequest('http://localhost/api/nylas/connect?provider=google'),
    );
    expect(response.status).toBe(503);
    const { deps: crashing } = deps(
      { mode: 'new' },
      {
        startGoogleMailConnect: async () => {
          throw new Error('boom');
        },
      },
    );
    await expect(
      createNylasConnectGet(crashing as any)(
        new NextRequest('http://localhost/api/nylas/connect?provider=google'),
      ),
    ).rejects.toThrow('boom');
  });
});

describe('POST /api/cron/google-history', () => {
  test('needs the cron secret and both ids, then starts the sync and answers at once', async () => {
    const runs: any[] = [];
    let authorized = false;
    const post = createGoogleHistoryPost({
      isInternalCronRequest: () => authorized,
      syncGoogleHistory: async (input: any) => {
        runs.push(input);
        throw new Error('logged, not thrown');
      },
    } as any);
    const request = (body: unknown) =>
      new NextRequest('http://localhost/api/cron/google-history', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    expect((await post(request({ userId: 'u', accountId: 'a' }))).status).toBe(401);
    authorized = true;
    expect((await post(request({ userId: 'u' }))).status).toBe(400);
    const accepted = await post(request({ userId: ' u ', accountId: 'a' }));
    expect(accepted.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(runs).toEqual([{ userId: 'u', accountId: 'a' }]);
  });
});
