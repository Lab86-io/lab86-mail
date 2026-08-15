import { describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createCheckinAnswerPost } from '../app/api/albatross/checkin/[checkinId]/answer/route';

const user = {
  userId: 'checkin-user',
  email: 'person@example.test',
  name: 'Check-in User',
  source: 'clerk' as const,
};

function request() {
  return new NextRequest('http://localhost/api/albatross/checkin/checkin-1/answer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tomorrowIntentText: 'Renew my passport',
      timezone: 'America/New_York',
    }),
  });
}

function malformedRequest() {
  return new NextRequest('http://localhost/api/albatross/checkin/checkin-1/answer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not-json',
  });
}

function dependencies() {
  return {
    requireCurrentUser: mock(async () => user),
    enforceUserRateLimit: mock(async () => ({ ok: true }) as any),
    generateTextForCurrentUser: mock(async () => ({ text: '{"completed":[]}' }) as any),
    convexQuery: mock(async () => ({
      status: 'open',
      candidateItems: [],
    })) as any,
    convexMutation: mock(async () => ({ status: 'answered' })) as any,
    advanceWork: mock(async () => ({
      status: 'ready' as const,
      workId: 'work-tomorrow',
      planId: 'plan-tomorrow',
    })),
  };
}

async function invoke(deps: ReturnType<typeof dependencies>) {
  return createCheckinAnswerPost(deps as any)(request(), {
    params: Promise.resolve({ checkinId: 'checkin-1' }),
  });
}

describe('Albatross check-in answer route', () => {
  test('treats malformed JSON as an invalid empty answer', async () => {
    const deps = dependencies();

    const response = await createCheckinAnswerPost(deps as any)(malformedRequest(), {
      params: Promise.resolve({ checkinId: 'checkin-1' }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: 'Tell Albatross what happened.' });
    expect(deps.convexQuery).not.toHaveBeenCalled();
  });

  test('keeps the answered check-in when intent creation is temporarily unavailable', async () => {
    const deps = dependencies();
    let mutationCount = 0;
    deps.convexMutation.mockImplementation(async () => {
      mutationCount += 1;
      if (mutationCount === 1) return { status: 'answered' };
      throw new Error('intent service unavailable');
    });

    const response = await invoke(deps);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      status: 'answered',
      tomorrowPlanStatus: 'degraded',
      tomorrowPlanError: 'intent service unavailable',
    });
    expect(deps.advanceWork).not.toHaveBeenCalled();
  });

  test('returns the durable Work id when planning fails after idempotent creation', async () => {
    const deps = dependencies();
    let mutationCount = 0;
    deps.convexMutation.mockImplementation(async () => {
      mutationCount += 1;
      return mutationCount === 1 ? { status: 'answered' } : 'work-tomorrow';
    });
    let queryCount = 0;
    deps.convexQuery.mockImplementation(async () => {
      queryCount += 1;
      return queryCount === 1 ? { status: 'open', candidateItems: [] } : null;
    });
    deps.advanceWork.mockImplementation(async () => {
      throw new Error('planner unavailable');
    });

    const response = await invoke(deps);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      status: 'answered',
      tomorrowWorkId: 'work-tomorrow',
      tomorrowPlanStatus: 'degraded',
      tomorrowPlanError: 'planner unavailable',
    });
    expect(deps.advanceWork).toHaveBeenCalledWith({
      userId: user.userId,
      userEmail: user.email,
      userName: user.name,
      workId: 'work-tomorrow',
      timezone: 'America/New_York',
    });
  });
});
