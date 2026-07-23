import { describe, expect, mock, test } from 'bun:test';
import type { NextRequest } from 'next/server';
import { createActivityPost } from '../app/api/mobile/activity/route';
import { AuthRequiredError } from '../lib/auth/current-user';

const user = {
  userId: 'user_test',
  email: 'person@example.test',
  name: 'Person',
  source: 'clerk' as const,
};

function dependencies() {
  return {
    currentUser: mock(async () => user),
    listPendingSuggestions: mock(async () => [
      { _id: 'suggestion_1', title: 'Review this', status: 'pending' },
    ]) as any,
    latestUnansweredCheckin: mock(async () => ({
      _id: 'checkin_1',
      status: 'open',
    })) as any,
    listPendingQuestions: mock(async () => [
      { questionId: 'question_1', prompt: 'Which deadline applies?', status: 'pending' },
    ]) as any,
  };
}

async function invoke(deps: ReturnType<typeof dependencies>) {
  return createActivityPost(deps as any)({} as NextRequest);
}

describe('mobile activity route', () => {
  test('returns pending suggestions and the latest unanswered check-in for the signed-in user', async () => {
    const deps = dependencies();

    const response = await invoke(deps);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      suggestions: [{ _id: 'suggestion_1', title: 'Review this', status: 'pending' }],
      checkin: { _id: 'checkin_1', status: 'open' },
      questions: [{ questionId: 'question_1', prompt: 'Which deadline applies?', status: 'pending' }],
    });
    expect(deps.currentUser).toHaveBeenCalledTimes(1);
    expect(deps.listPendingSuggestions).toHaveBeenCalledWith({
      userId: user.userId,
      limit: 50,
    });
    expect(deps.latestUnansweredCheckin).toHaveBeenCalledWith({ userId: user.userId });
    expect(deps.listPendingQuestions).toHaveBeenCalledWith({ userId: user.userId, limit: 50 });
  });

  test('returns the controlled authentication error without querying activity', async () => {
    const deps = dependencies();
    deps.currentUser.mockImplementation(async () => {
      throw new AuthRequiredError('Sign in required.');
    });

    const response = await invoke(deps);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: 'Sign in required.' });
    expect(deps.listPendingSuggestions).not.toHaveBeenCalled();
    expect(deps.latestUnansweredCheckin).not.toHaveBeenCalled();
    expect(deps.listPendingQuestions).not.toHaveBeenCalled();
  });

  test('does not expose unexpected server errors', async () => {
    const deps = dependencies();
    deps.listPendingSuggestions.mockImplementation(async () => {
      throw new Error('private provider failure');
    });

    const response = await invoke(deps);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'Activity could not be loaded.',
    });
    expect(deps.latestUnansweredCheckin).toHaveBeenCalledWith({ userId: user.userId });
  });
});
