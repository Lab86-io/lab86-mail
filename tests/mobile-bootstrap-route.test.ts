import { describe, expect, mock, test } from 'bun:test';
import { createMobileBootstrapGet } from '../app/api/mobile/v1/bootstrap/route';
import { AuthRequiredError } from '../lib/auth/current-user';

function dependencies(imageUrl = 'javascript:alert(1)', syncError?: unknown) {
  return {
    requireCurrentUser: mock(async () => ({
      userId: 'bootstrap_user',
      email: 'owner@example.test',
      name: 'Owner',
      imageUrl,
      source: 'clerk' as const,
    })),
    bootstrapState: mock(async () => ({
      accounts: [
        {
          accountId: 'account-1',
          email: 'owner@example.test',
          provider: 'google',
          status: 'connected',
          displayName: 'Main',
          scopes: ['mail.read'],
        },
      ],
      mailSync: [
        {
          accountId: 'account-1',
          status: 'ready',
          corpusReady: true,
          messagesSynced: 0,
          lastIncrementalSyncAt: 0,
          lastBackfillAt: 123,
          ...(syncError === undefined ? {} : { error: syncError }),
        },
      ],
      heads: [{ domain: 'mail', revision: 4 }],
      preferences: { nativePushEnabled: false },
    })) as any,
    now: () => new Date('2026-07-23T12:00:00.000Z'),
  };
}

describe('mobile bootstrap route', () => {
  test('a long raw sync error is cut to the contract cap instead of failing the bootstrap', async () => {
    const rawError = `Provider refused: ${'x'.repeat(2_000)} \ud83d`;
    const deps = dependencies(undefined, rawError);

    const response = await createMobileBootstrapGet(deps as any)(
      new Request('http://localhost/api/mobile/v1/bootstrap'),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.accounts[0].sync.error.length).toBe(500);
    expect(body.accounts[0].sync.error.startsWith('Provider refused: ')).toBe(true);
  });

  test('an empty or non-string sync error reads as no error', async () => {
    const empty = await createMobileBootstrapGet(dependencies(undefined, '') as any)(
      new Request('http://localhost/api/mobile/v1/bootstrap'),
    );
    expect((await empty.json()).accounts[0].sync.error).toBeUndefined();

    const numeric = await createMobileBootstrapGet(dependencies(undefined, 503) as any)(
      new Request('http://localhost/api/mobile/v1/bootstrap'),
    );
    expect((await numeric.json()).accounts[0].sync.error).toBe('503');
  });

  test('serializes account sync fields and zero cursors without unsafe image URLs', async () => {
    const deps = dependencies();

    const response = await createMobileBootstrapGet(deps as any)(
      new Request('http://localhost/api/mobile/v1/bootstrap', {
        headers: { 'x-request-id': 'bootstrap-request' },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('bootstrap-request');
    expect(body.user).toEqual({
      id: 'bootstrap_user',
      email: 'owner@example.test',
      name: 'Owner',
    });
    expect(body.accounts[0]).toMatchObject({
      id: 'account-1',
      sync: {
        status: 'ready',
        corpusReady: true,
        itemsSynced: 0,
        lastSyncedAt: 0,
      },
    });
    expect(body.cursors).toEqual({
      accounts: '0',
      mail: '4',
      calendar: '0',
      tasks: '0',
      today: '0',
      work: '0',
      assistant: '0',
      activity: '0',
    });
    expect(body.notificationSettings).toMatchObject({
      nativePushEnabled: false,
      newMailPushEnabled: true,
    });
    expect(body.serverTime).toBe('2026-07-23T12:00:00.000Z');
  });

  test('keeps a valid HTTP profile image URL', async () => {
    const response = await createMobileBootstrapGet(
      dependencies('https://images.example.test/person.png') as any,
    )(new Request('http://localhost/api/mobile/v1/bootstrap'));

    expect((await response.json()).user.imageURL).toBe('https://images.example.test/person.png');
  });

  test('maps authentication and Convex failures through the mobile error contract', async () => {
    const auth = dependencies();
    auth.requireCurrentUser.mockImplementation(async () => {
      throw new AuthRequiredError('Sign in required.');
    });
    const failed = dependencies();
    failed.bootstrapState.mockImplementation(async () => {
      throw new Error('private bootstrap failure');
    });

    const authResponse = await createMobileBootstrapGet(auth as any)(
      new Request('http://localhost/api/mobile/v1/bootstrap'),
    );
    const failedResponse = await createMobileBootstrapGet(failed as any)(
      new Request('http://localhost/api/mobile/v1/bootstrap'),
    );

    expect(authResponse.status).toBe(401);
    expect(failedResponse.status).toBe(500);
  });
});
