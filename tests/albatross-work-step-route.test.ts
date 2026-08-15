import { describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createWorkStepPost } from '../app/api/albatross/work/[workId]/step/route';
import { StepExecutionError } from '../lib/albatross/step-execution';
import { AuthRequiredError } from '../lib/auth/current-user';

const user = {
  userId: 'step-user',
  email: 'person@example.test',
  name: 'Step User',
  source: 'clerk' as const,
};

function request() {
  return new NextRequest('http://localhost/api/albatross/work/work-1/step', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stepKey: 'step-1', timezone: 'America/New_York' }),
  });
}

function dependencies() {
  return {
    requireCurrentUser: mock(async () => user),
    enforceUserRateLimit: mock(async () => ({ ok: true }) as any),
    completeWorkStep: mock(async () => ({ transitioned: true, closed: false, replanned: true })) as any,
  };
}

async function invoke(deps: ReturnType<typeof dependencies>) {
  return createWorkStepPost(deps as any)(request(), {
    params: Promise.resolve({ workId: 'work-1' }),
  });
}

describe('Albatross Work step route', () => {
  test('requires authentication before completing a step', async () => {
    const deps = dependencies();
    deps.requireCurrentUser.mockImplementation(async () => {
      throw new AuthRequiredError('Sign in required.');
    });

    const response = await invoke(deps);

    expect(response.status).toBe(401);
    expect(deps.completeWorkStep).not.toHaveBeenCalled();
  });

  test('preserves typed missing-work and no-current-step statuses', async () => {
    for (const [status, message] of [
      [404, 'Albatross Work not found.'],
      [409, 'There is no current step to complete.'],
    ] as const) {
      const deps = dependencies();
      deps.completeWorkStep.mockImplementation(async () => {
        throw new StepExecutionError(message, status);
      });

      const response = await invoke(deps);

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ ok: false, error: message });
    }
  });

  test('classifies unexpected execution failures as server errors', async () => {
    const deps = dependencies();
    deps.completeWorkStep.mockImplementation(async () => {
      throw new Error('task provider unavailable');
    });

    const response = await invoke(deps);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: 'task provider unavailable' });
  });
});
