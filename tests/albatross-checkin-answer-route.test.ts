import { describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createCheckinAnswerPost } from '../app/api/albatross/checkin/[checkinId]/answer/route';

const user = {
  userId: 'checkin-user',
  email: 'person@example.test',
  name: 'Check-in User',
  source: 'clerk' as const,
};

function request(body: unknown) {
  return new NextRequest('http://localhost/api/albatross/checkin/checkin-1/answer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function dependencies() {
  return {
    requireCurrentUser: mock(async () => user),
    enforceUserRateLimit: mock(async () => ({ ok: true }) as any),
    convexMutation: mock(async (_fn: any, args: any) => ({
      status: 'open',
      promptKind: args.promptKind,
      ...(args.promptKind === 'reflection'
        ? { reflectionReconcileStatus: 'pending' }
        : { tomorrowPlanStatus: 'pending' }),
    })) as any,
    reportUnexpectedError: mock(() => undefined),
  };
}

async function invoke(deps: ReturnType<typeof dependencies>, body: unknown) {
  return createCheckinAnswerPost(deps as any)(request(body), {
    params: Promise.resolve({ checkinId: 'checkin-1' }),
  });
}

describe('Albatross check-in answer route', () => {
  test('treats malformed and non-object JSON as an invalid empty answer', async () => {
    for (const body of ['{not-json', 'null', '[]', '"answer"']) {
      const deps = dependencies();
      const response = await invoke(deps, body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ ok: false, error: 'Tell Albatross what happened.' });
      expect(deps.convexMutation).not.toHaveBeenCalled();
    }
  });

  test('saves the reflection immediately and queues interpretation', async () => {
    const deps = dependencies();
    const response = await invoke(deps, {
      promptKind: 'reflection',
      responseText: 'I submitted the application.',
      completed: [{ kind: 'work', id: 'work-1' }],
      timezone: 'America/New_York',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      saved: { reflection: true, tomorrow: false },
      reflectionReconcileStatus: 'pending',
    });
    expect(deps.convexMutation).toHaveBeenCalledTimes(1);
    expect(deps.convexMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ promptKind: 'reflection', responseText: 'I submitted the application.' }),
    );
  });

  test('saves tomorrow independently without running planning in the request', async () => {
    const deps = dependencies();
    const response = await invoke(deps, {
      promptKind: 'tomorrow',
      responseText: 'Renew my passport',
      timezone: 'America/New_York',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      saved: { reflection: false, tomorrow: true },
      tomorrowPlanStatus: 'pending',
    });
    expect(deps.convexMutation).toHaveBeenCalledTimes(1);
  });

  test('keeps the combined request shape compatible while saving each section separately', async () => {
    const deps = dependencies();
    const response = await invoke(deps, {
      responseText: 'Finished the filing.',
      tomorrowIntentText: 'Call the DMV.',
      completed: [],
    });

    expect(response.status).toBe(200);
    expect(deps.convexMutation).toHaveBeenCalledTimes(2);
    expect(await response.json()).toMatchObject({
      ok: true,
      saved: { reflection: true, tomorrow: true },
    });
  });

  test('does not expose unexpected server failures', async () => {
    const deps = dependencies();
    deps.convexMutation.mockImplementation(async () => {
      throw new Error('private Convex failure');
    });
    const response = await invoke(deps, { promptKind: 'tomorrow', responseText: 'Call the DMV.' });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: 'Check-in answer failed.' });
    expect(deps.reportUnexpectedError).toHaveBeenCalledTimes(1);
  });
});
