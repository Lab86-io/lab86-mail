import { describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createNylasOAuthCallback } from '../app/api/nylas/callback/route';
import { createNylasOAuthFinalize } from '../app/api/nylas/finalize/route';
import { AuthRequiredError } from '../lib/auth/current-user';
import { completeNylasConnection, normalizeProvider } from '../lib/nylas/oauth-connection';
import { RateLimitError } from '../lib/rate-limit';

const NATIVE_STATE = {
  userId: 'user_1',
  provider: 'google',
  redirectTo: 'lab86-native-callback',
  nativeCallback: true,
};
const WEB_STATE = { userId: 'user_1', provider: 'google', redirectTo: '/settings' };

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    convexMutation: async () => NATIVE_STATE,
    requireNylas: () => {
      throw new Error('token exchange must not run here');
    },
    encryptSecret: (value: string) => value,
    nylasRedirectUri: () => 'http://localhost/api/nylas/callback',
    syncCalendarAccount: async () => undefined,
    maybeKickCorpusBackfill: () => undefined,
    maybeKickContactSync: () => undefined,
    requireCurrentUser: async () => ({ userId: 'user_1' }),
    saveOAuthCompletion: async () => {
      throw new Error('a completion must not be stored here');
    },
    ...overrides,
  } as any;
}

function exchangingNylas(record: { destroyed?: string[]; exchanged?: string[] } = {}) {
  return () => ({
    auth: {
      exchangeCodeForToken: async ({ code }: { code: string }) => {
        record.exchanged?.push(code);
        return {
          provider: 'google',
          email: 'private@example.test',
          grantId: 'grant_1',
          accessToken: 'access_1',
          refreshToken: 'refresh_1',
          expiresIn: 3600,
          scope: 'mail.read  calendar.read',
        };
      },
    },
    grants: {
      destroy: async ({ grantId }: { grantId: string }) => {
        record.destroyed?.push(grantId);
      },
    },
  });
}

describe('Nylas OAuth callback', () => {
  test('rejects a missing state before consuming or exchanging anything', async () => {
    let consumed = false;
    const callback = createNylasOAuthCallback(
      dependencies({
        convexMutation: async () => {
          consumed = true;
          return null;
        },
      }),
    );

    const response = await callback(new NextRequest('http://localhost/api/nylas/callback?code=code_1'));

    expect(response.headers.get('location')).toContain('nylas_error=Missing+OAuth+state');
    expect(consumed).toBe(false);
  });

  test('returns a native provider denial to the app without reflecting provider detail', async () => {
    const callback = createNylasOAuthCallback(dependencies());
    const response = await callback(
      new NextRequest(
        'http://localhost/api/nylas/callback?state=state_1&error_description=private_provider_detail',
      ),
    );
    const location = response.headers.get('location') || '';

    expect(response.status).toBe(307);
    expect(location).toContain('lab86://oauth/mail?nylas_error=Authorization+was+not+completed');
    expect(location).not.toContain('private_provider_detail');
  });

  test('redirects an invalid or expired consumed state without exchanging a token', async () => {
    const callback = createNylasOAuthCallback(
      dependencies({
        convexMutation: async () => null,
      }),
    );

    const response = await callback(
      new NextRequest('http://localhost/api/nylas/callback?state=expired_state&code=code_1'),
    );

    expect(response.headers.get('location')).toContain('nylas_error=OAuth+state+is+invalid+or+expired');
  });

  test('does not exchange a missing authorization code', async () => {
    const callback = createNylasOAuthCallback(dependencies());
    const response = await callback(new NextRequest('http://localhost/api/nylas/callback?state=state_1'));

    expect(response.headers.get('location')).toContain(
      'lab86://oauth/mail?nylas_error=The+provider+did+not+return+an+authorization+code',
    );
  });

  test('keeps a native approval for the app to redeem and never exchanges it in the browser', async () => {
    const saved: Array<Record<string, unknown>> = [];
    const callback = createNylasOAuthCallback(
      dependencies({
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
      new NextRequest('http://localhost/api/nylas/callback?state=state_1&code=code_1'),
    );

    expect(response.headers.get('location')).toBe('lab86://oauth/mail?nylas_completion=completion_token_1');
    expect(saved).toEqual([
      { userId: 'user_1', kind: 'mail', payload: { code: 'code_1', provider: 'google' } },
    ]);
  });

  test('treats the legacy native redirect marker as a native flow', async () => {
    const callback = createNylasOAuthCallback(
      dependencies({
        convexMutation: async () => ({
          userId: 'user_1',
          provider: 'google',
          redirectTo: 'lab86-native-callback',
        }),
        saveOAuthCompletion: async () => 'completion_token_2',
      }),
    );

    const response = await callback(
      new NextRequest('http://localhost/api/nylas/callback?state=state_1&code=code_1'),
    );

    expect(response.headers.get('location')).toBe('lab86://oauth/mail?nylas_completion=completion_token_2');
  });

  test('refuses a web approval when the browser session belongs to another user', async () => {
    const exchanged: string[] = [];
    const callback = createNylasOAuthCallback(
      dependencies({
        convexMutation: async () => WEB_STATE,
        requireNylas: exchangingNylas({ exchanged }),
        requireCurrentUser: async () => ({ userId: 'victim_user' }),
      }),
    );

    const response = await callback(
      new NextRequest('http://localhost/api/nylas/callback?state=state_1&code=code_1'),
    );
    const location = new URL(response.headers.get('location') || '');

    expect(location.pathname).toBe('/settings');
    expect(location.searchParams.get('nylas_error')).toBe('Sign in again and retry the connection.');
    expect(exchanged).toEqual([]);
  });

  test('refuses a web approval with no browser session', async () => {
    const exchanged: string[] = [];
    const callback = createNylasOAuthCallback(
      dependencies({
        convexMutation: async () => WEB_STATE,
        requireNylas: exchangingNylas({ exchanged }),
        requireCurrentUser: async () => {
          throw new AuthRequiredError('Sign in required.');
        },
      }),
    );

    const response = await callback(
      new NextRequest('http://localhost/api/nylas/callback?state=state_1&code=code_1'),
    );

    expect(response.headers.get('location')).toContain('nylas_error=Sign+in+again');
    expect(exchanged).toEqual([]);
  });

  test('connects a web approval for the signed-in user who started it', async () => {
    let mutation = 0;
    const upserts: Array<Record<string, unknown>> = [];
    const syncs: Array<Record<string, unknown>> = [];
    const backfills: Array<Record<string, unknown>> = [];
    const contactKicks: Array<Record<string, unknown>> = [];
    const destroyed: string[] = [];
    const callback = createNylasOAuthCallback(
      dependencies({
        convexMutation: async (_fn: unknown, args: Record<string, unknown>) => {
          mutation += 1;
          if (mutation === 1) return WEB_STATE;
          upserts.push(args);
          return { accountId: 'account_1', replacedGrantId: 'grant_old' };
        },
        requireNylas: exchangingNylas({ destroyed }),
        syncCalendarAccount: async (input: Record<string, unknown>) => {
          syncs.push(input);
          return undefined;
        },
        maybeKickCorpusBackfill: (input: Record<string, unknown>) => {
          backfills.push(input);
        },
        maybeKickContactSync: (input: Record<string, unknown>, options: Record<string, unknown>) => {
          contactKicks.push({ ...input, ...options });
        },
      }),
    );

    const response = await callback(
      new NextRequest('http://localhost/api/nylas/callback?state=state_1&code=code_1'),
    );
    const location = new URL(response.headers.get('location') || '');
    await Promise.resolve();

    expect(location.pathname).toBe('/settings');
    expect(location.searchParams.get('nylas_connected')).toBe('1');
    expect(location.toString()).not.toContain('private@example.test');
    expect(upserts[0]).toMatchObject({
      userId: 'user_1',
      email: 'private@example.test',
      provider: 'google',
      grantId: 'grant_1',
      accessTokenEncrypted: 'access_1',
      refreshTokenEncrypted: 'refresh_1',
      scopes: ['mail.read', 'calendar.read'],
    });
    expect(syncs).toEqual([
      { userId: 'user_1', accountId: 'account_1', force: true, reason: 'oauth_callback' },
    ]);
    expect(backfills).toEqual([{ userId: 'user_1', accountId: 'account_1' }]);
    expect(contactKicks).toEqual([
      { userId: 'user_1', accountId: 'account_1', force: true, reason: 'oauth_callback' },
    ]);
    expect(destroyed).toEqual(['grant_old']);
  });

  test('preserves native callback mode after a completion write failure', async () => {
    const callback = createNylasOAuthCallback(
      dependencies({
        saveOAuthCompletion: async () => {
          throw new Error('private storage detail');
        },
      }),
    );

    const response = await callback(
      new NextRequest('http://localhost/api/nylas/callback?state=state_1&code=code_1'),
    );
    const location = response.headers.get('location') || '';

    expect(location).toContain(
      'lab86://oauth/mail?nylas_error=Could+not+complete+authorization.+Please+try+again',
    );
    expect(location).not.toContain('private');
  });

  test('reports a web token-exchange failure without provider detail', async () => {
    const callback = createNylasOAuthCallback(
      dependencies({
        convexMutation: async () => WEB_STATE,
        requireNylas: () => ({
          auth: {
            exchangeCodeForToken: async () => {
              throw new Error('private token exchange detail');
            },
          },
        }),
      }),
    );

    const response = await callback(
      new NextRequest('http://localhost/api/nylas/callback?state=state_1&code=code_1'),
    );
    const location = new URL(response.headers.get('location') || '');

    expect(location.pathname).toBe('/settings');
    expect(location.searchParams.get('nylas_error')).toBe(
      'Could not complete authorization. Please try again.',
    );
  });

  test('sanitizes a stored browser redirect before returning to the site', async () => {
    const callback = createNylasOAuthCallback(
      dependencies({
        convexMutation: async () => ({
          userId: 'user_1',
          provider: 'google',
          redirectTo: 'https://attacker.example.test/steal',
        }),
      }),
    );
    const response = await callback(
      new NextRequest('http://localhost/api/nylas/callback?state=state_1&error=access_denied'),
    );

    expect(new URL(response.headers.get('location') || '').pathname).toBe('/');
  });
});

function finalizeRequest(body: unknown) {
  return new NextRequest('http://localhost/api/nylas/finalize', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

const TOKEN = 'c'.repeat(43);

function finalizeDependencies(overrides: Record<string, unknown> = {}) {
  return {
    requireCurrentUser: async () => ({ userId: 'user_1' }),
    enforceUserRateLimit: async () => undefined,
    consumeOAuthCompletion: async () => ({ code: 'code_1', provider: 'google' }),
    completeNylasConnection: async () => ({ accountId: 'account_1' }),
    ...overrides,
  } as any;
}

describe('Nylas OAuth finalize', () => {
  test('redeems a completion for the signed-in user only', async () => {
    const consumed: Array<Record<string, unknown>> = [];
    const completed: Array<Record<string, unknown>> = [];
    const finalize = createNylasOAuthFinalize(
      finalizeDependencies({
        consumeOAuthCompletion: async (input: Record<string, unknown>) => {
          consumed.push(input);
          return { code: 'code_1', provider: 'microsoft' };
        },
        completeNylasConnection: async (input: Record<string, unknown>) => {
          completed.push(input);
          return { accountId: 'account_1' };
        },
      }),
    );

    const response = await finalize(finalizeRequest({ completionToken: TOKEN }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(consumed).toEqual([{ userId: 'user_1', kind: 'mail', completionToken: TOKEN }]);
    expect(completed).toEqual([{ userId: 'user_1', code: 'code_1', provider: 'microsoft' }]);
  });

  test('refuses an unknown, expired, or foreign completion', async () => {
    let completed = false;
    const finalize = createNylasOAuthFinalize(
      finalizeDependencies({
        consumeOAuthCompletion: async () => null,
        completeNylasConnection: async () => {
          completed = true;
          return {};
        },
      }),
    );

    const response = await finalize(finalizeRequest({ completionToken: TOKEN }));

    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe('Mailbox authorization is invalid or expired.');
    expect(completed).toBe(false);
  });

  test('requires a signed-in app session', async () => {
    const finalize = createNylasOAuthFinalize(
      finalizeDependencies({
        requireCurrentUser: async () => {
          throw new AuthRequiredError('Sign in required.');
        },
      }),
    );

    const response = await finalize(finalizeRequest({ completionToken: TOKEN }));

    expect(response.status).toBe(401);
  });

  test('rejects a malformed token before it reads storage', async () => {
    let consumed = false;
    const finalize = createNylasOAuthFinalize(
      finalizeDependencies({
        consumeOAuthCompletion: async () => {
          consumed = true;
          return null;
        },
      }),
    );

    const short = await finalize(finalizeRequest({ completionToken: 'short' }));
    const invalidJson = await finalize(finalizeRequest('{'));

    expect(short.status).toBe(400);
    expect(invalidJson.status).toBe(400);
    expect(consumed).toBe(false);
  });

  test('returns rate limits and hides unexpected failures', async () => {
    const limited = createNylasOAuthFinalize(
      finalizeDependencies({
        enforceUserRateLimit: async () => {
          throw new RateLimitError('Too many requests.', 30_000, 10);
        },
      }),
    );
    const failing = createNylasOAuthFinalize(
      finalizeDependencies({
        completeNylasConnection: async () => {
          throw new Error('private exchange detail');
        },
      }),
    );

    const limitedResponse = await limited(finalizeRequest({ completionToken: TOKEN }));
    const failedResponse = await failing(finalizeRequest({ completionToken: TOKEN }));
    const failedBody = await failedResponse.json();

    expect(limitedResponse.status).toBe(429);
    expect(failedResponse.status).toBe(500);
    expect(JSON.stringify(failedBody)).not.toContain('private');
  });
});

describe('Nylas connection completion', () => {
  test('stores no token fields that the provider left out and skips the grant cleanup', async () => {
    const upserts: Array<Record<string, unknown>> = [];
    let destroyed = false;
    const result = await completeNylasConnection(
      { userId: 'user_1', code: 'code_1', provider: 'imap' },
      {
        requireNylas: (() => ({
          auth: {
            exchangeCodeForToken: async () => ({ email: 'a@example.test', grantId: 'grant_2' }),
          },
          grants: {
            destroy: async () => {
              destroyed = true;
            },
          },
        })) as any,
        nylasRedirectUri: () => 'http://localhost/api/nylas/callback',
        convexMutation: (async (_fn: unknown, args: Record<string, unknown>) => {
          upserts.push(args);
          return null;
        }) as any,
      },
    );

    expect(result).toEqual({ accountId: undefined });
    expect(upserts[0]).toMatchObject({
      userId: 'user_1',
      provider: 'imap',
      grantId: 'grant_2',
      accessTokenEncrypted: undefined,
      refreshTokenEncrypted: undefined,
      expiresAt: undefined,
      scopes: [],
    });
    expect(destroyed).toBe(false);
  });

  test('maps unknown providers to IMAP', () => {
    expect(normalizeProvider('google')).toBe('google');
    expect(normalizeProvider('microsoft')).toBe('microsoft');
    expect(normalizeProvider('icloud')).toBe('icloud');
    expect(normalizeProvider('yahoo')).toBe('imap');
  });
});
