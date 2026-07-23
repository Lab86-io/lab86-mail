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

  test('does not exchange a missing authorization code', async () => {
    const callback = createNylasOAuthCallback(dependencies());
    const response = await callback(new NextRequest('http://localhost/api/nylas/callback?state=state_1'));

    expect(response.headers.get('location')).toContain(
      'lab86://oauth/mail?nylas_error=The+provider+did+not+return+an+authorization+code',
    );
  });
});
