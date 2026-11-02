// What a run does after the user decides its approval (docs/albatross-step-runner.md).
// Web and iOS decide through the same two tools, so this runs on the server for both.
//
// A handoff with next.kind `approve` has one job left: the user's answer. When
// the last open approval of the run is decided and no other part of its
// package waits, the handoff must not stay open:
// - Something was approved and went out: the same path as "Mark step done" on
//   a step run and "Done, continue" on a goal run. The next part starts, and
//   the Work closes only when its proofs hold.
// - Everything was declined: the handoff closes. The step stays open, so the
//   user can start it again or change it.
// A failed call goes back to the queue (albatross_approve_action), so it does
// not reach this file.

import { api, convexMutation, convexQuery } from '../hosted/convex';
import { truncateText } from '../shared/text';
import { isGoalRun } from './goal-run-view';
import { completeStepAndContinue, continueGoalRun } from './step-run-start';

export interface ApprovalRunState {
  run: {
    id: string;
    workId: string;
    stepKey: string;
    goal?: boolean | null;
    state: string;
    next: { kind: string } | null;
    items?: ReadonlyArray<{ kind: string; state: string }> | null;
  };
  /** Approvals of this run that still wait for the user or are in flight. */
  open: number;
  approved: number;
}

export type RunAfterDecision = 'leave' | 'continue' | 'close';

export function runAfterDecision(state: ApprovalRunState | null | undefined): RunAfterDecision {
  if (!state || state.run.state !== 'handed_off' || state.run.next?.kind !== 'approve') return 'leave';
  if (state.open > 0) return 'leave';
  // A draft or a document of the same package still waits for the user.
  const otherParts = (state.run.items ?? []).some(
    (item) => item.kind !== 'approval' && item.state !== 'ready',
  );
  if (otherParts) return 'leave';
  return state.approved > 0 ? 'continue' : 'close';
}

export type RunFollowUp =
  | { action: 'none' }
  | { action: 'continued'; nextRunId: string | null }
  | { action: 'closed' };

export interface SettleRunInput {
  userId: string;
  userEmail?: string | null;
  userName?: string | null;
  timezone?: string;
  approval: { title?: string; artifactKind?: string; operationBatchId?: string };
}

type CompleteInput = Parameters<typeof completeStepAndContinue>[0];
type ContinueInput = Parameters<typeof continueGoalRun>[0];

// An import cycle runs through the step runner, so these resolve at call time.
const defaults = {
  convexQuery,
  convexMutation,
  completeStepAndContinue: (input: CompleteInput) => completeStepAndContinue(input),
  continueGoalRun: (input: ContinueInput) => continueGoalRun(input),
};

export type SettleRunDependencies = typeof defaults;

/** The words for the next run and the step record: it went out, so nobody sends it twice. */
function approvedNote(title: string | undefined): string {
  const what = title?.trim();
  return truncateText(
    `The user approved this, and it went out${what ? `: ${what}` : ''}. Do not send it again.`,
    600,
  );
}

/**
 * Never throws: the user's decision already stands. A step that cannot
 * complete, or a goal that cannot continue, still closes the handoff.
 */
export async function settleRunAfterDecision(
  input: SettleRunInput,
  overrides: Partial<SettleRunDependencies> = {},
): Promise<RunFollowUp> {
  const deps = { ...defaults, ...overrides };
  const runId = input.approval.operationBatchId;
  if (input.approval.artifactKind !== 'step_run' || !runId) return { action: 'none' };
  const close = async (): Promise<RunFollowUp> => {
    await deps.convexMutation(api.albatrossStepRuns.dismissHandoff, {
      userId: input.userId,
      id: runId as never,
    });
    return { action: 'closed' };
  };
  try {
    const state = await deps.convexQuery<ApprovalRunState | null>(api.albatrossStepRuns.approvalRunState, {
      userId: input.userId,
      runId,
    });
    const after = runAfterDecision(state);
    if (after === 'leave' || !state) return { action: 'none' };
    const first = await deps.convexMutation<boolean>(api.albatrossStepRuns.claimApprovalSettlement, {
      userId: input.userId,
      runId,
    });
    if (!first) return { action: 'none' };
    if (after === 'close') return await close();
    const { run } = state;
    const note = approvedNote(input.approval.title);
    try {
      const check = isGoalRun(run)
        ? await deps.continueGoalRun({ userId: input.userId, workId: run.workId, note })
        : await deps.completeStepAndContinue({
            userId: input.userId,
            userEmail: input.userEmail,
            userName: input.userName,
            workId: run.workId,
            stepKey: run.stepKey,
            timezone: input.timezone,
            note,
          });
      return { action: 'continued', nextRunId: check.nextRunId };
    } catch (error) {
      console.warn('[approval-run] could not continue', error instanceof Error ? error.name : 'error');
      return await close();
    }
  } catch (error) {
    console.warn('[approval-run] could not settle', error instanceof Error ? error.name : 'error');
    return { action: 'none' };
  }
}
