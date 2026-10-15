// The route calls of a goal run from the web client, each behind one
// function (docs/albatross-goal-runs.md G1 Start, G1 Done). The server owner
// adjusts the bodies here when the final shape lands; the components do not
// know them.

import { GOAL_STEP_KEY } from './goal-run-contract';
import { postJson } from './work-view';

export const GOAL_CLIENT_COPY = {
  startFailed: 'Albatross could not start.',
  continueFailed: 'Albatross could not continue from here.',
} as const;

function timezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** "Handle it" on a goal Work: a run with no step. */
export function goalStartBody(): Record<string, unknown> {
  return { action: 'start' };
}

/**
 * "Done, continue" on a goal handoff: the user did their part. The server
 * checks the outcome contract and closes the Work only when the proofs hold.
 */
export function goalContinueBody(): Record<string, unknown> {
  return { stepKey: GOAL_STEP_KEY, continue: true, timezone: timezone() };
}

export async function postGoalStart(workId: string): Promise<{ runId: string | null }> {
  const result = await postJson(
    `/api/albatross/work/${encodeURIComponent(workId)}/run`,
    goalStartBody(),
    GOAL_CLIENT_COPY.startFailed,
  );
  return { runId: typeof result?.runId === 'string' ? result.runId : null };
}

export async function postGoalContinue(
  workId: string,
): Promise<{ nextRunId: string | null; allStepsComplete: boolean }> {
  const result = await postJson(
    `/api/albatross/work/${encodeURIComponent(workId)}/step`,
    goalContinueBody(),
    GOAL_CLIENT_COPY.continueFailed,
  );
  return {
    nextRunId: typeof result?.nextRunId === 'string' ? result.nextRunId : null,
    allStepsComplete: Boolean(result?.allStepsComplete),
  };
}
