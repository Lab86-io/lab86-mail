import { describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createNylasOAuthCallback } from '../app/api/nylas/callback/route';

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    convexMutation: async () => ({
      userId: 'user_1',
      provider: 'google',
      redirectTo: 'lab86-native-callback',
    }),
    requireNylas: () => {
      throw new Error('token exchange must not run on denial');
    },
    encryptSecret: (value: string) => value,
    syncCalendarAccount: async () => undefined,
    maybeKickCorpusBackfill: () => undefined,
    ...overrides,
  } as any;
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

  test('returns successful native authorization without exposing mailbox identity', async () => {
    let mutation = 0;
    const upserts: Array<Record<string, unknown>> = [];
    const syncs: Array<Record<string, unknown>> = [];
    const backfills: Array<Record<string, unknown>> = [];
    const destroyedGrants: string[] = [];
    const callback = createNylasOAuthCallback(
      dependencies({
        convexMutation: async (_fn: unknown, args: Record<string, unknown>) => {
          mutation += 1;
          if (mutation === 1) {
            return {
              userId: 'user_1',
              provider: 'google',
              redirectTo: 'lab86-native-callback',
            };
          }
          upserts.push(args);
          return { accountId: 'account_1', replacedGrantId: 'grant_old' };
        },
        requireNylas: () => ({
          auth: {
            exchangeCodeForToken: async () => ({
              provider: 'google',
              email: 'private@example.test',
              grantId: 'grant_1',
              accessToken: 'access_1',
              scope: 'mail.read',
            }),
          },
          grants: {
            destroy: async ({ grantId }: { grantId: string }) => {
              destroyedGrants.push(grantId);
            },
          },
        }),
        syncCalendarAccount: async (input: Record<string, unknown>) => {
          syncs.push(input);
          return undefined;
        },
        maybeKickCorpusBackfill: (input: Record<string, unknown>) => {
          backfills.push(input);
        },
      }),
    );

    const response = await callback(
      new NextRequest('http://localhost/api/nylas/callback?state=state_1&code=code_1'),
    );
    const location = response.headers.get('location') || '';
    await Promise.resolve();

    expect(location).toBe('lab86://oauth/mail?nylas_connected=1');
    expect(location).not.toContain('private@example.test');
    expect(upserts[0]).toMatchObject({
      userId: 'user_1',
      email: 'private@example.test',
      provider: 'google',
      grantId: 'grant_1',
    });
    expect(syncs).toEqual([
      { userId: 'user_1', accountId: 'account_1', force: true, reason: 'oauth_callback' },
    ]);
    expect(backfills).toEqual([{ userId: 'user_1', accountId: 'account_1' }]);
    expect(destroyedGrants).toEqual(['grant_old']);
  });

  test('preserves native callback mode after a token-exchange failure', async () => {
    const callback = createNylasOAuthCallback(
      dependencies({
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
    const location = response.headers.get('location') || '';

    expect(location).toContain(
      'lab86://oauth/mail?nylas_error=Could+not+complete+authorization.+Please+try+again',
    );
    expect(location).not.toContain('private');
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
