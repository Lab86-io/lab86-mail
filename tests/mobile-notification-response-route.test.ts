import { describe, expect, mock, test } from 'bun:test';
import { createNotificationResponsePost } from '../app/api/mobile/notifications/respond/route';
import { AuthRequiredError } from '../lib/auth/current-user';

const user = {
  userId: 'user_1',
  email: 'user@example.test',
  name: 'User',
  source: 'clerk' as const,
};

function request(body: unknown) {
  return new Request('http://localhost/api/mobile/notifications/respond', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function dependencies() {
  return {
    requireCurrentUser: mock(async () => user),
    enforceUserRateLimit: mock(async () => undefined),
    query: mock(async () => ({
      _id: 'notice_1',
      userId: user.userId,
      type: 'daily_checkin',
      entityKind: 'checkin',
      entityId: 'checkin_1',
      deepLink: '/?checkin=checkin_1&prompt=tomorrow',
    })),
    mutate: mock(async () => ({ status: 'open' })),
  };
}

describe('mobile notification text response route', () => {
  test('stores the prompt-specific freeform response against the owned check-in', async () => {
    const deps = dependencies();
    const post = createNotificationResponsePost(deps as any);

    const response = await post(
      request({ notificationId: 'notice_1', responseText: 'Ship the review', promptKind: 'tomorrow' }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, promptKind: 'tomorrow', status: 'open' });
    expect(deps.mutate.mock.calls[0][1]).toEqual({
      userId: user.userId,
      checkinId: 'checkin_1',
      promptKind: 'tomorrow',
      responseText: 'Ship the review',
      completed: [],
    });
  });

  test('infers tomorrow from the signed notification context, never the client alone', async () => {
    const deps = dependencies();
    const post = createNotificationResponsePost(deps as any);

    const response = await post(
      request({
        notificationId: 'notice_1',
        responseText: 'Finish the deck',
        promptKind: 'reflection',
      }),
    );

    expect(response.status).toBe(200);
    expect(deps.mutate.mock.calls[0][1]).toMatchObject({ promptKind: 'tomorrow' });
  });

  test('rejects empty text and non-replyable or foreign notification ids', async () => {
    const malformedDeps = dependencies();
    const malformedPost = createNotificationResponsePost(malformedDeps as any);
    expect((await malformedPost(request({ notificationId: 'notice_1', responseText: ' ' }))).status).toBe(
      400,
    );

    const missingDeps = dependencies();
    missingDeps.query.mockImplementation(async () => null as any);
    const missing = await createNotificationResponsePost(missingDeps as any)(
      request({ notificationId: 'foreign', responseText: 'Private' }),
    );
    expect(missing.status).toBe(404);
    expect(missingDeps.mutate).not.toHaveBeenCalled();
  });

  test('rejects malformed JSON, wrong notification types, and missing check-in entities', async () => {
    const malformedDeps = dependencies();
    const malformed = new Request('http://localhost/api/mobile/notifications/respond', {
      method: 'POST',
      body: '{',
    });
    expect((await createNotificationResponsePost(malformedDeps as any)(malformed)).status).toBe(400);

    for (const notification of [
      {
        _id: 'mail_notice',
        userId: user.userId,
        type: 'mail_message',
        entityKind: 'thread',
        entityId: 'thread_1',
        deepLink: '/mail/thread_1',
      },
      {
        _id: 'broken_checkin',
        userId: user.userId,
        type: 'daily_checkin',
        entityKind: 'checkin',
        entityId: '',
        deepLink: '/?prompt=reflection',
      },
    ]) {
      const deps = dependencies();
      deps.query.mockImplementation(async () => notification as any);
      const response = await createNotificationResponsePost(deps as any)(
        request({ notificationId: notification._id, responseText: 'Private answer' }),
      );
      expect(response.status).toBe(404);
      expect(deps.mutate).not.toHaveBeenCalled();
    }
  });

  test('preserves authentication failures without exposing backend detail', async () => {
    const deps = dependencies();
    deps.requireCurrentUser.mockImplementation(async () => {
      throw new AuthRequiredError('Sign in required.');
    });
    const response = await createNotificationResponsePost(deps as any)(
      request({ notificationId: 'notice_1', responseText: 'Done' }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: 'Sign in required.' });
  });
});
