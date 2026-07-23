import { describe, expect, mock, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { NextRequest } from 'next/server';
import { createNylasConnectGet } from '../app/api/nylas/connect/route';
import { AuthRequiredError } from '../lib/auth/current-user';
import { RateLimitError } from '../lib/rate-limit';

const user = {
  userId: 'nylas_user',
  email: 'nylas@example.test',
  name: 'Nylas User',
  source: 'clerk' as const,
};

function dependencies(overrides: Record<string, unknown> = {}) {
  const mutations: Array<{ name: string; args: Record<string, unknown> }> = [];
  const deps = {
    requireCurrentUser: async () => user,
    isNylasConfigured: () => true,
    enforceUserRateLimit: async () => ({ ok: true }),
    convexMutation: mock(async (fn: unknown, args: Record<string, unknown>) => {
      mutations.push({ name: getFunctionName(fn as any), args });
      return { ok: true };
    }) as any,
    requireNylas: () => ({
      auth: {
        urlForOAuth2: (config: { state: string }) =>
          `https://provider.example.test/authorize?state=${config.state}`,
      },
    }),
    nylasRedirectUri: () => 'https://mail-staging.lab86.io/api/nylas/callback',
    randomState: () => 'nylas-state-1',
    ...overrides,
  };
  return {
    deps,
    mutations,
  };
}

describe('Nylas connect route', () => {
  test('returns the generated authorization URL for format=json', async () => {
    const { deps, mutations } = dependencies();
    const get = createNylasConnectGet(deps as any);

    const response = await get(
      new NextRequest(
        'http://localhost/api/nylas/connect?provider=google&format=json&redirectTo=%2Fsettings',
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      authorizationUrl: 'https://provider.example.test/authorize?state=nylas-state-1',
    });
    expect(mutations).toEqual([
      {
        name: 'users:upsertFromClerk',
        args: {
          userId: user.userId,
          email: user.email,
          name: user.name,
          imageUrl: undefined,
        },
      },
      {
        name: 'accounts:createOAuthState',
        args: expect.objectContaining({
          userId: user.userId,
          state: 'nylas-state-1',
          provider: 'google',
          redirectTo: '/settings',
          nativeCallback: false,
        }),
      },
    ]);
  });

  test('persists the shared native callback sentinel and mode', async () => {
    const { deps, mutations } = dependencies();

    await createNylasConnectGet(deps as any)(
      new NextRequest('http://localhost/api/nylas/connect?provider=google&format=json&native=1'),
    );

    expect(mutations[1]?.args).toMatchObject({
      redirectTo: 'lab86-native-callback',
      nativeCallback: true,
    });
  });

  test('returns configuration failure before spending rate-limit quota or writing state', async () => {
    let rateLimitChecked = false;
    const { deps, mutations } = dependencies({
      isNylasConfigured: () => false,
      enforceUserRateLimit: async () => {
        rateLimitChecked = true;
      },
    });

    const response = await createNylasConnectGet(deps as any)(
      new NextRequest('http://localhost/api/nylas/connect?provider=google&format=json'),
    );

    expect(response.status).toBe(503);
    expect(rateLimitChecked).toBe(false);
    expect(mutations).toEqual([]);
  });

  test('returns the established authentication failure without starting OAuth', async () => {
    const { deps, mutations } = dependencies({
      requireCurrentUser: async () => {
        throw new AuthRequiredError('Sign in required.');
      },
    });

    const response = await createNylasConnectGet(deps as any)(
      new NextRequest('http://localhost/api/nylas/connect?provider=google&format=json'),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: 'Sign in required.' });
    expect(mutations).toEqual([]);
  });

  test('returns the shared rate-limit contract without starting OAuth', async () => {
    const { deps, mutations } = dependencies({
      enforceUserRateLimit: async () => {
        throw new RateLimitError('Slow down.', 2_500, 10);
      },
      requireNylas: () => {
        throw new Error('OAuth must not start');
      },
    });

    const response = await createNylasConnectGet(deps as any)(
      new NextRequest('http://localhost/api/nylas/connect?provider=google&format=json'),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('3');
    expect(await response.json()).toEqual({
      ok: false,
      error: 'Slow down.',
      retryAfterSeconds: 3,
      limit: 10,
    });
    expect(mutations).toEqual([]);
  });
});
