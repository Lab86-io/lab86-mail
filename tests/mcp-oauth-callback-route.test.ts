import { describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createMcpOAuthCallback } from '../app/api/mcp/oauth/callback/route';
import { createMcpOAuthFinalize } from '../app/api/mcp/oauth/finalize/route';
import { AuthRequiredError } from '../lib/auth/current-user';
import { completeMcpOAuthConnection } from '../lib/mcp/oauth-connection';
import { getServerDef } from '../lib/mcp/servers';
import { RateLimitError } from '../lib/rate-limit';

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    convexMutation: async () => ({
      userId: 'user_1',
      server: 'granola',
      payloadEncrypted: 'payload',
      nativeCallback: false,
    }),
    getServerDef,
    decryptSecret: () => JSON.stringify({ state: 'state_1' }),
    finishMcpOAuth: async ({ persisted }: any) => ({
      ...persisted,
      clientInformation: { client_id: 'client_1' },
      tokens: { access_token: 'access_1', token_type: 'Bearer' },
    }),
    saveOAuthConnection: async () => ({ connectionId: 'granola_1' }),
    syncConnection: async () => ({ ok: true, count: 1 }),
    requireCurrentUser: async () => ({ userId: 'user_1' }),
    saveOAuthCompletion: async () => {
      throw new Error('a completion must not be stored here');
    },
    ...overrides,
  } as any;
}

describe('MCP OAuth callback', () => {
  test('rejects a missing state before consuming or exchanging anything', async () => {
    let consumed = false;
    const callback = createMcpOAuthCallback(
      dependencies({
        convexMutation: async () => {
          consumed = true;
          return null;
        },
      }),
    );

    const response = await callback(new NextRequest('http://localhost/api/mcp/oauth/callback?code=code_1'));

    expect(response.headers.get('location')).toContain('mcp_error=Missing+OAuth+state');
    expect(consumed).toBe(false);
  });

  test('redirects expired state instead of throwing a framework error', async () => {
    const callback = createMcpOAuthCallback(
      dependencies({
        convexMutation: async () => null,
      }),
    );

    const response = await callback(
      new NextRequest('http://localhost/api/mcp/oauth/callback?state=state_1&code=code_1'),
    );
    const location = response.headers.get('location') || '';

    expect(response.status).toBe(307);
    expect(location).toContain('mcp_error=OAuth+state+is+invalid+or+expired');
    expect(location).not.toContain('session');
  });

  test('keeps a native approval for the app to redeem and never exchanges it in the browser', async () => {
    const saved: Array<Record<string, unknown>> = [];
    const callback = createMcpOAuthCallback(
      dependencies({
        convexMutation: async () => ({
          userId: 'user_1',
          server: 'granola',
          payloadEncrypted: 'payload',
          nativeCallback: true,
        }),
        finishMcpOAuth: async () => {
          throw new Error('token exchange must not run in the browser');
        },
        requireCurrentUser: async () => {
          throw new Error('native callbacks must not need a browser session');
        },
        saveOAuthCompletion: async (input: Record<string, unknown>) => {
          saved.push(input);
          return 'completion_token_1';
        },
      }),
    );
    const response = await callback(
      new NextRequest('http://localhost/api/mcp/oauth/callback?state=state_1&code=code_1'),
    );
    expect(response.headers.get('location')).toBe(
      'lab86://oauth/connection?mcp_completion=completion_token_1',
    );
    expect(saved).toEqual([
      {
        userId: 'user_1',
        kind: 'mcp',
        payload: { server: 'granola', code: 'code_1', persisted: { state: 'state_1' } },
      },
    ]);
  });

  test('refuses a web approval when the browser session belongs to another user', async () => {
    let exchanged = false;
    const callback = createMcpOAuthCallback(
      dependencies({
        requireCurrentUser: async () => ({ userId: 'victim_user' }),
        finishMcpOAuth: async () => {
          exchanged = true;
          return {};
        },
      }),
    );
    const response = await callback(
      new NextRequest('http://localhost/api/mcp/oauth/callback?state=state_1&code=code_1'),
    );
    const location = new URL(response.headers.get('location') || '');

    expect(location.pathname).toBe('/settings');
    expect(location.searchParams.get('mcp_error')).toBe('Sign in again and retry the connection.');
    expect(exchanged).toBe(false);
  });

  test('refuses a web approval with no browser session', async () => {
    let exchanged = false;
    const callback = createMcpOAuthCallback(
      dependencies({
        requireCurrentUser: async () => {
          throw new AuthRequiredError('Sign in required.');
        },
        finishMcpOAuth: async () => {
          exchanged = true;
          return {};
        },
      }),
    );
    const response = await callback(
      new NextRequest('http://localhost/api/mcp/oauth/callback?state=state_1&code=code_1'),
    );

    expect(response.headers.get('location')).toContain('mcp_error=Sign+in+again');
    expect(exchanged).toBe(false);
  });

  test('connects a web approval for the signed-in user who started it', async () => {
    const saved: Array<Record<string, unknown>> = [];
    const callback = createMcpOAuthCallback(
      dependencies({
        saveOAuthConnection: async (input: Record<string, unknown>) => {
          saved.push(input);
          return { connectionId: 'granola_1' };
        },
      }),
    );
    const response = await callback(
      new NextRequest('http://localhost/api/mcp/oauth/callback?state=state_1&code=code_1'),
    );

    expect(response.headers.get('location')).toContain('/settings?mcp_connected=Granola');
    expect(saved[0]).toMatchObject({ userId: 'user_1', server: 'granola', displayName: 'Granola' });
  });

  test('refuses a stored payload whose state does not match the callback', async () => {
    const callback = createMcpOAuthCallback(
      dependencies({ decryptSecret: () => JSON.stringify({ state: 'other_state' }) }),
    );
    const response = await callback(
      new NextRequest('http://localhost/api/mcp/oauth/callback?state=state_1&code=code_1'),
    );

    expect(response.headers.get('location')).toContain('mcp_error=Could+not+complete+authorization');
  });

  test('never reflects raw provider errors into the settings redirect', async () => {
    const callback = createMcpOAuthCallback(dependencies());
    const response = await callback(
      new NextRequest(
        'http://localhost/api/mcp/oauth/callback?state=state_1&error_description=private_provider_detail',
      ),
    );
    const location = response.headers.get('location') || '';

    expect(location).toContain('mcp_error=Authorization+was+not+completed');
    expect(location).not.toContain('private_provider_detail');
  });

  test('preserves native callback mode for provider denial and a missing code', async () => {
    const deps = dependencies({
      convexMutation: async () => ({
        userId: 'user_1',
        server: 'granola',
        payloadEncrypted: 'payload',
        nativeCallback: true,
      }),
      finishMcpOAuth: async () => {
        throw new Error('token exchange must not run');
      },
    });
    const callback = createMcpOAuthCallback(deps);

    const denied = await callback(
      new NextRequest('http://localhost/api/mcp/oauth/callback?state=state_1&error=access_denied'),
    );
    const missingCode = await callback(
      new NextRequest('http://localhost/api/mcp/oauth/callback?state=state_1'),
    );

    expect(denied.headers.get('location')).toContain(
      'lab86://oauth/connection?mcp_error=Authorization+was+not+completed',
    );
    expect(missingCode.headers.get('location')).toContain(
      'lab86://oauth/connection?mcp_error=The+provider+did+not+return+an+authorization+code',
    );
  });

  test('reports web exchange and first-sync failures without provider detail', async () => {
    const exchangeFailure = createMcpOAuthCallback(
      dependencies({
        finishMcpOAuth: async () => {
          throw new Error('private token failure');
        },
      }),
    );
    const syncFailure = createMcpOAuthCallback(
      dependencies({
        syncConnection: async () => ({ ok: false, error: 'private sync detail' }),
      }),
    );

    const exchange = await exchangeFailure(
      new NextRequest('http://localhost/api/mcp/oauth/callback?state=state_1&code=code_1'),
    );
    const sync = await syncFailure(
      new NextRequest('http://localhost/api/mcp/oauth/callback?state=state_1&code=code_1'),
    );

    expect(exchange.headers.get('location')).toContain(
      '/settings?mcp_error=Could+not+complete+authorization',
    );
    expect(exchange.headers.get('location')).not.toContain('private');
    expect(sync.headers.get('location')).toContain(
      '/settings?mcp_error=Connected%2C+but+the+first+sync+failed',
    );
    expect(sync.headers.get('location')).not.toContain('private');
  });

  test('preserves native callback mode after a completion write failure', async () => {
    const callback = createMcpOAuthCallback(
      dependencies({
        convexMutation: async () => ({
          userId: 'user_1',
          server: 'granola',
          payloadEncrypted: 'payload',
          nativeCallback: true,
        }),
        saveOAuthCompletion: async () => {
          throw new Error('private storage detail');
        },
      }),
    );
    const response = await callback(
      new NextRequest('http://localhost/api/mcp/oauth/callback?state=state_1&code=code_1'),
    );

    expect(response.headers.get('location')).toContain(
      'lab86://oauth/connection?mcp_error=Could+not+complete+authorization',
    );
    expect(response.headers.get('location')).not.toContain('private');
  });
});

function finalizeRequest(body: unknown) {
  return new NextRequest('http://localhost/api/mcp/oauth/finalize', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

const TOKEN = 'm'.repeat(43);
const COMPLETION = { server: 'granola', code: 'code_1', persisted: { state: 'state_1' } };

function finalizeDependencies(overrides: Record<string, unknown> = {}) {
  return {
    requireCurrentUser: async () => ({ userId: 'user_1' }),
    enforceUserRateLimit: async () => undefined,
    consumeOAuthCompletion: async () => COMPLETION,
    completeMcpOAuthConnection: async () => ({ ok: true, label: 'Granola', connectionId: 'granola_1' }),
    ...overrides,
  } as any;
}

describe('MCP OAuth finalize', () => {
  test('redeems a completion for the signed-in user only', async () => {
    const consumed: Array<Record<string, unknown>> = [];
    const completed: Array<Record<string, unknown>> = [];
    const finalize = createMcpOAuthFinalize(
      finalizeDependencies({
        consumeOAuthCompletion: async (input: Record<string, unknown>) => {
          consumed.push(input);
          return COMPLETION;
        },
        completeMcpOAuthConnection: async (input: Record<string, unknown>) => {
          completed.push(input);
          return { ok: true, label: 'Granola', connectionId: 'granola_1' };
        },
      }),
    );

    const response = await finalize(finalizeRequest({ completionToken: TOKEN }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, connected: 'Granola', connectionId: 'granola_1' });
    expect(consumed).toEqual([{ userId: 'user_1', kind: 'mcp', completionToken: TOKEN }]);
    expect(completed).toEqual([{ ...COMPLETION, userId: 'user_1' }]);
  });

  test('refuses an unknown, expired, or foreign completion', async () => {
    const finalize = createMcpOAuthFinalize(
      finalizeDependencies({ consumeOAuthCompletion: async () => null }),
    );

    const response = await finalize(finalizeRequest({ completionToken: TOKEN }));

    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe('Connection authorization is invalid or expired.');
  });

  test('reports a failed first sync without provider detail', async () => {
    const finalize = createMcpOAuthFinalize(
      finalizeDependencies({
        completeMcpOAuthConnection: async () => ({
          ok: false,
          label: 'Granola',
          connectionId: 'granola_1',
          error: 'private sync detail',
        }),
      }),
    );

    const response = await finalize(finalizeRequest({ completionToken: TOKEN }));
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.error).toBe('Connected, but the first sync failed. Please reconnect and try again.');
    expect(JSON.stringify(body)).not.toContain('private');
  });

  test('requires a signed-in app session and a well-formed token', async () => {
    const signedOut = createMcpOAuthFinalize(
      finalizeDependencies({
        requireCurrentUser: async () => {
          throw new AuthRequiredError('Sign in required.');
        },
      }),
    );
    const finalize = createMcpOAuthFinalize(finalizeDependencies());

    expect((await signedOut(finalizeRequest({ completionToken: TOKEN }))).status).toBe(401);
    expect((await finalize(finalizeRequest({ completionToken: 'short' }))).status).toBe(400);
    expect((await finalize(finalizeRequest('{'))).status).toBe(400);
  });

  test('returns rate limits and hides unexpected failures', async () => {
    const limited = createMcpOAuthFinalize(
      finalizeDependencies({
        enforceUserRateLimit: async () => {
          throw new RateLimitError('Too many requests.', 30_000, 10);
        },
      }),
    );
    const failing = createMcpOAuthFinalize(
      finalizeDependencies({
        completeMcpOAuthConnection: async () => {
          throw new Error('private exchange detail');
        },
      }),
    );

    const limitedResponse = await limited(finalizeRequest({ completionToken: TOKEN }));
    const failedResponse = await failing(finalizeRequest({ completionToken: TOKEN }));

    expect(limitedResponse.status).toBe(429);
    expect(failedResponse.status).toBe(500);
    expect(JSON.stringify(await failedResponse.json())).not.toContain('private');
  });
});

describe('MCP connection completion', () => {
  test('refuses a server that does not use browser authorization', async () => {
    await expect(
      completeMcpOAuthConnection({
        userId: 'user_1',
        server: 'github',
        code: 'c',
        persisted: { state: 's' },
      }),
    ).rejects.toThrow('Unsupported OAuth server.');
    await expect(
      completeMcpOAuthConnection({ userId: 'user_1', server: 'nope', code: 'c', persisted: { state: 's' } }),
    ).rejects.toThrow('Unsupported OAuth server.');
  });

  test('exchanges, saves, and syncs for the given user', async () => {
    const calls: string[] = [];
    const result = await completeMcpOAuthConnection(
      { userId: 'user_1', server: 'granola', code: 'code_1', persisted: { state: 'state_1' } },
      {
        finishMcpOAuth: (async ({ code }: { code: string }) => {
          calls.push(`finish:${code}`);
          return { state: 'state_1', tokens: { access_token: 'a', token_type: 'Bearer' } };
        }) as any,
        saveOAuthConnection: (async ({ userId }: { userId: string }) => {
          calls.push(`save:${userId}`);
          return { connectionId: 'granola_1' };
        }) as any,
        syncConnection: (async (userId: string, connectionId: string) => {
          calls.push(`sync:${userId}:${connectionId}`);
          return { ok: true, count: 2 };
        }) as any,
      },
    );

    expect(result).toEqual({ ok: true, label: 'Granola', connectionId: 'granola_1' });
    expect(calls).toEqual(['finish:code_1', 'save:user_1', 'sync:user_1:granola_1']);
  });
});
