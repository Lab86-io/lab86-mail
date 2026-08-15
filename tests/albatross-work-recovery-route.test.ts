import { describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createWorkRecoveryPost } from '../app/api/albatross/work/[workId]/recover/route';

const user = {
  userId: 'recovery-user',
  email: 'person@example.test',
  name: 'Recovery User',
  source: 'clerk' as const,
};

function request(recovery: string) {
  return new NextRequest('http://localhost/api/albatross/work/work-1/recover', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ recovery, stepKey: 'step-1', timezone: 'America/New_York' }),
  });
}

function dependencies() {
  return {
    requireCurrentUser: mock(async () => user),
    enforceUserRateLimit: mock(async () => ({ ok: true }) as any),
    convexQuery: mock(async () => ({
      work: { _id: 'work-1', workState: 'active' },
      execution: {
        currentStep: { key: 'step-1' },
        guideSteps: [{ key: 'step-1', title: 'Submit the form' }],
      },
    })) as any,
    convexMutation: mock(async () => ({ ok: true })) as any,
    completeWorkStep: mock(async () => ({ transitioned: true, closed: false, replanned: true })) as any,
    advanceWork: mock(async () => ({
      status: 'ready' as const,
      workId: 'work-1',
      planId: 'plan-2',
    })),
  };
}

async function invoke(deps: ReturnType<typeof dependencies>, recovery: string) {
  return createWorkRecoveryPost(deps as any)(request(recovery), {
    params: Promise.resolve({ workId: 'work-1' }),
  });
}

describe('Albatross Work recovery route', () => {
  test('returns 404 without recording a lapse when the Work is missing', async () => {
    const deps = dependencies();
    deps.convexQuery.mockImplementation(async () => null);

    const response = await invoke(deps, 'move');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, error: 'Albatross Work not found.' });
    expect(deps.convexMutation).not.toHaveBeenCalled();
    expect(deps.advanceWork).not.toHaveBeenCalled();
  });

  test('replans every recovery that leaves the Work active', async () => {
    for (const recovery of ['move', 'shrink', 'delegate', 'rebuild']) {
      const deps = dependencies();

      const response = await invoke(deps, recovery);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, recovery, replanned: true });
      expect(deps.advanceWork).toHaveBeenCalledTimes(1);
      expect(deps.advanceWork).toHaveBeenCalledWith(
        expect.objectContaining({ userId: user.userId, workId: 'work-1' }),
      );
    }
  });

  test('waiting, pausing, and releasing are terminal recovery transitions for this request', async () => {
    const expectedState = { wait: 'waiting', pause: 'paused', release: 'released' } as const;
    for (const recovery of Object.keys(expectedState) as Array<keyof typeof expectedState>) {
      const deps = dependencies();

      const response = await invoke(deps, recovery);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        recovery,
        state: expectedState[recovery],
        replanned: false,
      });
      expect(deps.advanceWork).not.toHaveBeenCalled();
      expect(deps.completeWorkStep).not.toHaveBeenCalled();
    }
  });
});
