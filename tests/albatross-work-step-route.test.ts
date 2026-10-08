import { describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createWorkStepPost } from '../app/api/albatross/work/[workId]/step/route';
import { completeWorkStep, StepExecutionError } from '../lib/albatross/step-execution';
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
    completeWorkStep: mock(async () => ({
      transitioned: true,
      closed: false,
      replanned: false,
      followUp: 'not_needed',
    })) as any,
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
    // The provider message stays in the server log (CASA S7).
    expect(await response.json()).toEqual({
      ok: false,
      error: 'Step update failed.',
    });
  });
});

describe('step completion notes', () => {
  function noteDeps() {
    const completeWorkStep = mock(async (input: any) => ({ ok: true, received: input }));
    return {
      requireCurrentUser: mock(async () => ({ userId: 'user-1', email: 'u@e.com', name: 'U' })) as any,
      enforceUserRateLimit: mock(async () => undefined) as any,
      completeWorkStep: completeWorkStep as any,
      completeStepAndContinue: mock(async () => {
        throw new Error('not used');
      }) as any,
    };
  }

  function stepRequest(body: unknown) {
    return new NextRequest('http://localhost/api/albatross/work/work-1/step', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  const context = { params: Promise.resolve({ workId: 'work-1' }) };

  test('a note is forwarded and clamped to 2,000 characters', async () => {
    const deps = noteDeps();
    const post = createWorkStepPost(deps);
    await post(stepRequest({ stepKey: 'step-1', note: `keep ${'x'.repeat(3000)}` }), context);
    const input = (deps.completeWorkStep as any).mock.calls[0][0];
    expect(input.note.startsWith('keep ')).toBe(true);
    expect(input.note.length).toBeLessThanOrEqual(2_000);
  });

  test('a non-string note is ignored', async () => {
    const deps = noteDeps();
    const post = createWorkStepPost(deps);
    await post(stepRequest({ stepKey: 'step-1', note: 123 }), context);
    const input = (deps.completeWorkStep as any).mock.calls[0][0];
    expect(input.note).toBeUndefined();
  });

  test('a whitespace-only note never reaches the mutation', async () => {
    let mutationArgs: any;
    const result = await completeWorkStep(
      { userId: 'user-1', workId: 'work-1', stepKey: 'step-1', note: '   ' },
      {
        convexMutation: mock(async (_fn: any, args: any) => {
          mutationArgs = args;
          return {
            stepKey: 'step-1',
            stepIdentity: 'id',
            stepTitle: 'T',
            planId: 'p',
            cardId: null,
            allStepsComplete: false,
            workState: 'active',
            transitioned: true,
          };
        }) as any,
        convexQuery: mock(async () => null) as any,
      },
    );
    expect(result.stepKey).toBe('step-1');
    expect(mutationArgs.note).toBeUndefined();
  });
});

// "Mark step done" with continue: true checks the step and starts the next one
// (docs/albatross-document-handoff.md, D3).
describe('continue: true', () => {
  function continueDeps() {
    return {
      requireCurrentUser: mock(async () => user) as any,
      enforceUserRateLimit: mock(async () => ({ ok: true })) as any,
      completeWorkStep: mock(async () => ({ stepKey: 'step-1', allStepsComplete: false })) as any,
      completeStepAndContinue: mock(async (_input: any) => ({
        stepKey: 'step-1',
        allStepsComplete: false,
        nextRunId: 'run-2',
        nextStepKey: 'step-2',
      })) as any,
    };
  }

  function post(body: unknown) {
    return new NextRequest('http://localhost/api/albatross/work/work-1/step', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  const context = { params: Promise.resolve({ workId: 'work-1' }) };

  test('calls completeStepAndContinue and returns its fields', async () => {
    const deps = continueDeps();
    const response = await createWorkStepPost(deps)(
      post({ stepKey: 'step-1', continue: true, note: 'The hours are in.', timezone: 'America/Chicago' }),
      context,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      stepKey: 'step-1',
      allStepsComplete: false,
      nextRunId: 'run-2',
      nextStepKey: 'step-2',
    });
    expect(deps.completeWorkStep).not.toHaveBeenCalled();
    expect(deps.completeStepAndContinue.mock.calls[0][0]).toEqual({
      userId: 'step-user',
      userEmail: 'person@example.test',
      userName: 'Step User',
      workId: 'work-1',
      stepKey: 'step-1',
      timezone: 'America/Chicago',
      note: 'The hours are in.',
    });
  });

  test('without continue, or with a value that is not true, the plain check runs', async () => {
    for (const body of [{ stepKey: 'step-1' }, { stepKey: 'step-1', continue: 'true' }]) {
      const deps = continueDeps();
      const response = await createWorkStepPost(deps)(post(body), context);
      expect(await response.json()).toEqual({ ok: true, stepKey: 'step-1', allStepsComplete: false });
      expect(deps.completeWorkStep).toHaveBeenCalledTimes(1);
      expect(deps.completeStepAndContinue).not.toHaveBeenCalled();
    }
  });

  test('a typed error from the continue path keeps its status', async () => {
    const deps = continueDeps();
    deps.completeStepAndContinue.mockImplementation(async () => {
      throw new StepExecutionError('There is no current step to complete.', 409);
    });
    const response = await createWorkStepPost(deps)(post({ continue: true }), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: 'There is no current step to complete.' });
  });
});
