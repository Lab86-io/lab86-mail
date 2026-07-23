import { describe, expect, mock, test } from 'bun:test';
import type { NextRequest } from 'next/server';
import { createBriefResolvePost } from '../app/api/mobile/briefs/resolve/route';
import { AuthRequiredError } from '../lib/auth/current-user';

function request(body: unknown) {
  return new Request('https://example.test/api/mobile/briefs/resolve', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  }) as NextRequest;
}

function deps() {
  return {
    currentUser: mock(async () => ({
      userId: 'user-1',
      email: 'person@example.test',
      name: 'Person',
      source: 'clerk' as const,
    })),
    resolve: mock(async () => [
      {
        kind: 'thread' as const,
        id: 'thread-1',
        account: 'account-1',
        title: 'Current subject',
        unread: true,
        gone: false,
      },
    ]),
  };
}

describe('mobile brief resolve route', () => {
  test('batch resolves supported refs for the authenticated user', async () => {
    const dependencies = deps();
    const response = await createBriefResolvePost(dependencies)(
      request({
        refs: [
          { kind: 'thread', id: 'thread-1', account: 'account-1' },
          { kind: 'work', id: 'work-1' },
          { kind: 'derived', id: 'ignored' },
        ],
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      entities: [
        {
          kind: 'thread',
          id: 'thread-1',
          account: 'account-1',
          title: 'Current subject',
          unread: true,
          gone: false,
        },
      ],
    });
    expect(dependencies.resolve).toHaveBeenCalledWith({
      userId: 'user-1',
      refs: [
        { kind: 'thread', id: 'thread-1', account: 'account-1' },
        { kind: 'work', id: 'work-1' },
      ],
    });
  });

  test('rejects malformed or unauthenticated requests without resolving', async () => {
    const dependencies = deps();
    let response = await createBriefResolvePost(dependencies)(request({ refs: [] }));
    expect(response.status).toBe(400);
    expect(dependencies.resolve).not.toHaveBeenCalled();

    dependencies.currentUser.mockImplementation(async () => {
      throw new AuthRequiredError('Sign in required.');
    });
    response = await createBriefResolvePost(dependencies)(
      request({ refs: [{ kind: 'task', id: 'card-1' }] }),
    );
    expect(response.status).toBe(401);
  });
});
