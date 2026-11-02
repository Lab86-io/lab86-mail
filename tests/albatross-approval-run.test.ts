import { describe, expect, mock, spyOn, test } from 'bun:test';
import {
  type ApprovalRunState,
  runAfterDecision,
  type SettleRunDependencies,
  settleRunAfterDecision,
} from '../lib/albatross/approval-run';

/* What a run does after the user decides its approval, on web and on iOS. */

function state(
  over: Partial<ApprovalRunState['run']> = {},
  counts = { open: 0, approved: 1 },
): ApprovalRunState {
  return {
    run: {
      id: 'run-1',
      workId: 'work-1',
      stepKey: 'step-1',
      goal: false,
      state: 'handed_off',
      next: { kind: 'approve' },
      items: [],
      ...over,
    },
    ...counts,
  };
}

describe('runAfterDecision', () => {
  test('an approved last approval goes on', () => {
    expect(runAfterDecision(state())).toBe('continue');
  });

  test('everything declined closes the handoff', () => {
    expect(runAfterDecision(state({}, { open: 0, approved: 0 }))).toBe('close');
  });

  test('one approved and one declined still goes on, because something went out', () => {
    expect(runAfterDecision(state({}, { open: 0, approved: 1 }))).toBe('continue');
  });

  test('another open approval keeps the handoff open', () => {
    expect(runAfterDecision(state({}, { open: 1, approved: 1 }))).toBe('leave');
  });

  test('another part of the package that waits keeps the handoff open', () => {
    expect(
      runAfterDecision(
        state({
          items: [
            { kind: 'approval', state: 'check' },
            { kind: 'draft', state: 'check' },
          ],
        }),
      ),
    ).toBe('leave');
    expect(
      runAfterDecision(
        state({
          items: [
            { kind: 'approval', state: 'check' },
            { kind: 'document', state: 'ready' },
          ],
        }),
      ),
    ).toBe('continue');
  });

  test('a run with another next action, or one that already moved on, stays as it is', () => {
    expect(runAfterDecision(state({ next: { kind: 'review_draft' } }))).toBe('leave');
    expect(runAfterDecision(state({ next: null }))).toBe('leave');
    expect(runAfterDecision(state({ state: 'closed' }))).toBe('leave');
    expect(runAfterDecision(null)).toBe('leave');
  });
});

function harness(found: ApprovalRunState | null, overrides: Partial<SettleRunDependencies> = {}) {
  const dismissed: unknown[] = [];
  const completed: any[] = [];
  const continued: any[] = [];
  const deps: Partial<SettleRunDependencies> = {
    convexQuery: mock(async () => found) as never,
    convexMutation: mock(async (_fn: unknown, args: any) => {
      // The settlement claim names a run. A dismissal names its id.
      if (args?.runId) return true;
      dismissed.push(args);
      return { dismissed: true };
    }) as never,
    completeStepAndContinue: mock(async (input: unknown) => {
      completed.push(input);
      return { stepKey: 'step-1', allStepsComplete: false, nextRunId: 'run-2', nextStepKey: 'step-2' };
    }) as never,
    continueGoalRun: mock(async (input: unknown) => {
      continued.push(input);
      return { stepKey: 'goal', allStepsComplete: false, nextRunId: 'run-3', nextStepKey: 'goal' };
    }) as never,
    ...overrides,
  };
  return { deps, dismissed, completed, continued };
}

const input = {
  userId: 'user-1',
  userEmail: 'sam@example.com',
  userName: 'Sam',
  timezone: 'America/Chicago',
  approval: {
    title: 'Send the invite: Kickoff',
    artifactKind: 'step_run',
    operationBatchId: 'run-1',
  },
};

describe('settleRunAfterDecision', () => {
  test('an approval that no run queued does nothing', async () => {
    const h = harness(state());
    const followUp = await settleRunAfterDecision(
      { ...input, approval: { artifactKind: 'calendarEvent', operationBatchId: 'x' } },
      h.deps,
    );
    expect(followUp).toEqual({ action: 'none' });
    expect(h.deps.convexQuery).not.toHaveBeenCalled();
    expect(
      await settleRunAfterDecision({ ...input, approval: { artifactKind: 'step_run' } }, h.deps),
    ).toEqual({
      action: 'none',
    });
  });

  test('an approved step completes with the note, and the next step can start', async () => {
    const h = harness(state());
    expect(await settleRunAfterDecision(input, h.deps)).toEqual({ action: 'continued', nextRunId: 'run-2' });
    expect(h.completed[0]).toMatchObject({
      userId: 'user-1',
      workId: 'work-1',
      stepKey: 'step-1',
      timezone: 'America/Chicago',
    });
    expect(h.completed[0].note).toContain('it went out: Send the invite: Kickoff');
    expect(h.completed[0].note).toContain('Do not send it again.');
    expect(h.dismissed).toEqual([]);
  });

  test('an approved goal handoff continues the goal, so the contract check runs', async () => {
    const h = harness(state({ goal: true, stepKey: 'goal' }));
    expect(await settleRunAfterDecision(input, h.deps)).toEqual({ action: 'continued', nextRunId: 'run-3' });
    expect(h.continued[0]).toMatchObject({ userId: 'user-1', workId: 'work-1' });
    expect(h.completed).toEqual([]);
  });

  test('a second decision at the same time does not continue the run again', async () => {
    const claims: unknown[] = [];
    let wins = 1;
    const h = harness(state(), {
      convexMutation: mock(async (_fn: unknown, args: any) => {
        if (!args?.runId) return { dismissed: true };
        claims.push(args);
        return wins-- > 0;
      }) as never,
    });
    expect((await settleRunAfterDecision(input, h.deps)).action).toBe('continued');
    expect(await settleRunAfterDecision(input, h.deps)).toEqual({ action: 'none' });
    expect(claims).toHaveLength(2);
    expect(h.completed).toHaveLength(1);
  });

  test('a decline closes the handoff and starts nothing', async () => {
    const h = harness(state({}, { open: 0, approved: 0 }));
    expect(await settleRunAfterDecision(input, h.deps)).toEqual({ action: 'closed' });
    expect(h.dismissed).toEqual([{ userId: 'user-1', id: 'run-1' }]);
    expect(h.completed).toEqual([]);
    expect(h.continued).toEqual([]);
  });

  test('another open approval leaves the handoff alone', async () => {
    const h = harness(state({}, { open: 1, approved: 0 }));
    expect(await settleRunAfterDecision(input, h.deps)).toEqual({ action: 'none' });
    expect(h.dismissed).toEqual([]);
  });

  test('a step that cannot complete still closes the handoff, because the invite went out', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = harness(state(), {
      completeStepAndContinue: mock(async () => {
        throw new Error('Plan step not found.');
      }) as never,
    });
    try {
      expect(await settleRunAfterDecision(input, h.deps)).toEqual({ action: 'closed' });
      expect(h.dismissed).toEqual([{ userId: 'user-1', id: 'run-1' }]);
    } finally {
      warn.mockRestore();
    }
  });

  test('it never throws: the decision already stands', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = harness(state(), {
      convexQuery: mock(async () => {
        throw new Error('Convex is down.');
      }) as never,
    });
    try {
      expect(await settleRunAfterDecision(input, h.deps)).toEqual({ action: 'none' });
    } finally {
      warn.mockRestore();
    }
  });
});
