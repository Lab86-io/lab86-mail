import { describe, expect, mock, test } from 'bun:test';
import { createMobileSyncGet } from '../app/api/mobile/v1/sync/route';
import { AuthRequiredError } from '../lib/auth/current-user';

const user = {
  userId: 'sync_user',
  email: 'sync@example.test',
  name: 'Sync User',
  source: 'clerk' as const,
};

function dependencies(result: unknown = { page: [], serverRevision: 0, hasMore: false }) {
  return {
    requireCurrentUser: mock(async () => user),
    listSync: mock(async () => result) as any,
  };
}

function request(query: string) {
  return new Request(`http://localhost/api/mobile/v1/sync?${query}`, {
    headers: { 'x-request-id': 'sync-request' },
  });
}

describe('mobile sync route', () => {
  test('rejects invalid cursors through the typed mobile error contract', async () => {
    for (const cursor of ['-1', '1.5', 'abc', String(Number.MAX_SAFE_INTEGER + 1)]) {
      const response = await createMobileSyncGet(dependencies() as any)(
        request(`domain=mail&cursor=${cursor}`),
      );
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe('INVALID_REQUEST');
    }
  });

  test('normalizes and bounds requested limits', async () => {
    for (const [raw, expected] of [
      ['0', 1],
      ['2.9', 2],
      ['999', 500],
      ['not-a-number', 200],
    ] as const) {
      const deps = dependencies();
      await createMobileSyncGet(deps as any)(request(`domain=mail&cursor=4&limit=${raw}`));
      expect(deps.listSync.mock.calls[0][0]).toEqual({
        userId: user.userId,
        domain: 'mail',
        afterRevision: 4,
        limit: expected,
      });
    }
  });

  test('preserves an empty cursor and hasMore response', async () => {
    const response = await createMobileSyncGet(
      dependencies({ page: [], serverRevision: 9, hasMore: true }) as any,
    )(request('domain=tasks&cursor=7'));

    expect(await response.json()).toEqual({
      items: [],
      deletedIDs: [],
      cursor: '7',
      serverRevision: 9,
      hasMore: true,
    });
  });

  test('maps mixed changes and tombstones and advances to the last revision', async () => {
    const deps = dependencies({
      page: [
        {
          type: 'change',
          revision: 8,
          row: {
            domain: 'tasks',
            entityKind: 'task',
            entityId: 'task-1',
            revision: 8,
            payload: { cardID: 'task-1', completed: true },
          },
        },
        { type: 'tombstone', revision: 9, row: { entityId: 'task-2', revision: 9 } },
      ],
      serverRevision: 11,
      hasMore: false,
    });

    const response = await createMobileSyncGet(deps as any)(request('domain=tasks&cursor=7&limit=20'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [
        {
          domain: 'tasks',
          entityKind: 'task',
          entityID: 'task-1',
          revision: 8,
          operation: 'upsert',
          payload: { cardID: 'task-1', completed: true },
        },
      ],
      deletedIDs: ['task-2'],
      cursor: '9',
      serverRevision: 11,
      hasMore: false,
    });
    expect(response.headers.get('x-request-id')).toBe('sync-request');
  });

  test('maps authentication and query failures through mobileErrorResponse', async () => {
    const auth = dependencies();
    auth.requireCurrentUser.mockImplementation(async () => {
      throw new AuthRequiredError('Sign in required.');
    });
    const failed = dependencies();
    failed.listSync.mockImplementation(async () => {
      throw new Error('sync unavailable');
    });

    expect((await createMobileSyncGet(auth as any)(request('domain=mail'))).status).toBe(401);
    expect((await createMobileSyncGet(failed as any)(request('domain=mail'))).status).toBe(500);
  });
});
