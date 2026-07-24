import { describe, expect, mock, test } from 'bun:test';
import { createMobilePreferencesHandlers } from '../app/api/mobile/preferences/route';
import { AuthRequiredError } from '../lib/auth/current-user';
import { parseMobileNotificationPreferences } from '../lib/notifications/mobile-preferences';

const user = {
  userId: 'preferences_user',
  email: 'preferences@example.test',
  name: 'Preferences User',
  source: 'clerk' as const,
};

const preferences = {
  nativePushEnabled: true,
  newMailPushEnabled: true,
  eventSuggestionPushEnabled: false,
  morningBriefEnabled: true,
  eveningCheckinEnabled: true,
  eveningCheckinLocalTime: '19:30',
  inAppEnabled: true,
  emailFallbackEnabled: false,
  emailFallbackDelayMinutes: 90,
  timezone: 'America/New_York',
  briefLocationEnabled: false,
};

function request(body: unknown) {
  return new Request('http://localhost/api/mobile/preferences', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function dependencies() {
  return {
    requireCurrentUser: mock(async () => user),
    convexQuery: mock(async () => preferences) as any,
    convexMutation: mock(async () => undefined) as any,
    parseMobileNotificationPreferences,
  };
}

describe('mobile preferences route', () => {
  test('returns authenticated preferences', async () => {
    const deps = dependencies();
    const handlers = createMobilePreferencesHandlers(deps as any);

    const response = await handlers.POST();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, preferences });
    expect(deps.convexQuery.mock.calls[0][1]).toEqual({ userId: user.userId });
  });

  test('persists a validated preference update', async () => {
    const deps = dependencies();
    const handlers = createMobilePreferencesHandlers(deps as any);

    const response = await handlers.PUT(request(preferences));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(deps.convexMutation.mock.calls[0][1]).toMatchObject({ userId: user.userId, ...preferences });
  });

  test('returns 400 for malformed JSON and validation failures', async () => {
    const deps = dependencies();
    const handlers = createMobilePreferencesHandlers(deps as any);
    const malformed = new Request('http://localhost/api/mobile/preferences', {
      method: 'PUT',
      body: '{',
    });

    const malformedResponse = await handlers.PUT(malformed);
    const invalidResponse = await handlers.PUT(request({ ...preferences, timezone: 'not/a-zone' }));

    expect(malformedResponse.status).toBe(400);
    expect(invalidResponse.status).toBe(400);
    expect((await invalidResponse.json()).error).toBe('timezone must be a valid IANA timezone.');
    expect(deps.convexMutation).not.toHaveBeenCalled();
  });

  test('validates and forwards an explicitly opted-in approximate brief location', async () => {
    const deps = dependencies();
    const handlers = createMobilePreferencesHandlers(deps as any);
    const located = {
      ...preferences,
      briefLocationEnabled: true,
      briefLatitude: 43.15,
      briefLongitude: -77.62,
      briefLocationLabel: 'Rochester, New York',
      briefLocationAccuracy: 125,
      briefLocationUpdatedAt: 1_800_000_000_000,
    };

    const response = await handlers.PUT(request(located));

    expect(response.status).toBe(200);
    expect(deps.convexMutation.mock.calls[0][1]).toMatchObject(located);
  });

  test('preserves controlled authentication failures', async () => {
    const deps = dependencies();
    deps.requireCurrentUser.mockImplementation(async () => {
      throw new AuthRequiredError('Sign in required.');
    });
    const handlers = createMobilePreferencesHandlers(deps as any);

    const post = await handlers.POST();
    const put = await handlers.PUT(request(preferences));

    expect(post.status).toBe(401);
    expect(put.status).toBe(401);
    expect(await post.json()).toEqual({ ok: false, error: 'Sign in required.' });
  });

  test('does not expose Convex query or mutation failures', async () => {
    const queryDeps = dependencies();
    queryDeps.convexQuery.mockImplementation(async () => {
      throw new Error('private query detail');
    });
    const mutationDeps = dependencies();
    mutationDeps.convexMutation.mockImplementation(async () => {
      throw new Error('private mutation detail');
    });

    const post = await createMobilePreferencesHandlers(queryDeps as any).POST();
    const put = await createMobilePreferencesHandlers(mutationDeps as any).PUT(request(preferences));

    expect(post.status).toBe(500);
    expect(put.status).toBe(500);
    expect(await post.json()).toEqual({ ok: false, error: 'Notification preferences failed.' });
    expect(await put.json()).toEqual({ ok: false, error: 'Notification preferences failed.' });
  });
});
