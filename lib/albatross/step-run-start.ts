// Starting step runs: from the user ("Handle it", "Continue"), from an
// answered question, and from the automatic triggers (the Brief and the
// conductor). Convex owns the queue rules (one open run per Work, one
// automatic run per step); this module owns the switches, the standing
// order, and the step check.

import { api, convexMutation, convexQuery } from '../hosted/convex';
import { isStandingOrderPaused } from '../hosted/standing-orders';
import { truncateText } from '../shared/text';
import {
  automaticStepRunsEnabledFor,
  isAutomaticTrigger,
  type RunnableStepLike,
  stepAcceptsTrigger,
  stepRunsEnabled,
} from './step-run-policy';
import { CHAT_ANSWER_PREFIX } from './thread-contract';

export class StepRunStartError extends Error {
  constructor(
    message: string,
    readonly status: 403 | 404 | 409,
  ) {
    super(message);
    this.name = 'StepRunStartError';
  }
}

export interface StepRunStartDependencies {
  convexQuery: typeof convexQuery;
  convexMutation: typeof convexMutation;
  runsPaused: (userId: string) => Promise<boolean>;
}

const defaults: StepRunStartDependencies = {
  convexQuery,
  convexMutation,
  runsPaused: (userId) => isStandingOrderPaused(userId, 'runs'),
};

type EnqueueResult = { runId: string | null; created: boolean; reason: string | null };

export interface StartResult {
  runId: string | null;
  created: boolean;
  reason?: string | null;
}

async function loadStep(deps: StepRunStartDependencies, userId: string, workId: string, stepKey?: string) {
  const detail = await deps.convexQuery<any>(api.albatrossWorkV2.workDetail, { userId, workId });
  if (!detail?.work) return { detail: null, step: null, missingWork: true };
  const steps: RunnableStepLike[] = detail.execution?.guideSteps || [];
  const step = stepKey ? steps.find((entry) => entry.key === stepKey) : detail.execution?.currentStep;
  return {
    detail,
    step: (step || null) as (RunnableStepLike & { identity?: string }) | null,
    missingWork: false,
  };
}

/** Start a run on one step. A user start explains every refusal; an automatic start returns a reason. */
export async function startStepRun(
  input: {
    userId: string;
    workId: string;
    stepKey?: string;
    trigger: 'user' | 'brief' | 'conductor';
    /** What the user asked for, from the thread (docs/albatross-thread.md). */
    note?: string;
  },
  overrides: Partial<StepRunStartDependencies> = {},
): Promise<StartResult> {
  const deps = { ...defaults, ...overrides };
  const automatic = isAutomaticTrigger(input.trigger);
  if (!stepRunsEnabled()) {
    if (automatic) return { runId: null, created: false, reason: 'off' };
    throw new StepRunStartError('Step runs are off.', 403);
  }
  if (automatic) {
    if (!automaticStepRunsEnabledFor(input.userId))
      return { runId: null, created: false, reason: 'auto_off' };
    if (await deps.runsPaused(input.userId).catch(() => false))
      return { runId: null, created: false, reason: 'paused' };
  }
  const { step, missingWork } = await loadStep(deps, input.userId, input.workId, input.stepKey);
  if (missingWork) {
    if (automatic) return { runId: null, created: false, reason: 'no_work' };
    throw new StepRunStartError('Albatross Work not found.', 404);
  }
  if (!step) {
    if (automatic) return { runId: null, created: false, reason: 'no_step' };
    throw new StepRunStartError('There is no such step.', 404);
  }
  if (!stepAcceptsTrigger(step, input.trigger)) {
    if (automatic) return { runId: null, created: false, reason: 'not_runnable' };
    throw new StepRunStartError(
      step.done ? 'This step is already done.' : 'This step stays with you.',
      step.done ? 409 : 403,
    );
  }
  const result = await deps.convexMutation<EnqueueResult>(api.albatrossStepRuns.enqueue, {
    userId: input.userId,
    workId: input.workId,
    stepKey: step.key,
    stepIdentity: step.identity || step.key,
    stepTitle: step.title,
    trigger: input.trigger,
    ...(!automatic && input.note?.trim() ? { resumeNote: input.note.trim() } : {}),
  });
  if (!automatic && !result.created) {
    if (result.reason === 'active') throw new StepRunStartError('Albatross is already working on this.', 409);
    if (result.reason === 'busy')
      throw new StepRunStartError('Albatross is working on three steps now. Try again when one ends.', 409);
    if (result.reason === 'closed') throw new StepRunStartError('This Albatross is closed.', 409);
  }
  return result;
}

/** Continue after a handoff: the user signed in, answered, or pressed Continue. */
export async function resumeStepRun(
  input: { userId: string; workId: string; runId: string; note?: string },
  overrides: Partial<StepRunStartDependencies> = {},
): Promise<StartResult> {
  const deps = { ...defaults, ...overrides };
  if (!stepRunsEnabled()) throw new StepRunStartError('Step runs are off.', 403);
  const parent = await deps.convexQuery<any>(api.albatrossStepRuns.get, {
    userId: input.userId,
    id: input.runId,
  });
  if (!parent || parent.workId !== input.workId) throw new StepRunStartError('Run not found.', 404);
  const { step, missingWork } = await loadStep(deps, input.userId, input.workId, parent.stepKey);
  if (missingWork) throw new StepRunStartError('Albatross Work not found.', 404);
  if (!step) throw new StepRunStartError('This step is no longer in the plan.', 404);
  if (step.done) throw new StepRunStartError('This step is already done.', 409);
  // The plan may have changed since the handoff.
  if (!stepAcceptsTrigger(step, 'resume')) throw new StepRunStartError('This step stays with you.', 403);
  const result = await deps.convexMutation<EnqueueResult>(api.albatrossStepRuns.enqueue, {
    userId: input.userId,
    workId: input.workId,
    stepKey: step.key,
    stepIdentity: step.identity || step.key,
    stepTitle: step.title,
    trigger: 'resume',
    parentRunId: input.runId,
    ...(input.note?.trim() ? { resumeNote: input.note.trim() } : {}),
    ...(parent.browserSessionId ? { browserSessionId: parent.browserSessionId } : {}),
  });
  if (!result.created) {
    if (result.reason === 'active') throw new StepRunStartError('Albatross is already working on this.', 409);
    throw new StepRunStartError('The run could not continue now. Try again.', 409);
  }
  return result;
}

/**
 * An answer to a run's question continues that run. Returns the new run id,
 * or null when no run waits on this question.
 */
export async function resumeRunForAnswer(
  input: { userId: string; workId: string; questionId: string; answer: string },
  overrides: Partial<StepRunStartDependencies> = {},
): Promise<string | null> {
  const deps = { ...defaults, ...overrides };
  if (!stepRunsEnabled()) return null;
  const runs = await deps
    .convexQuery<any[]>(api.albatrossStepRuns.runsForWork, { userId: input.userId, workId: input.workId })
    .catch(() => []);
  const waiting = (runs || []).find(
    (run) =>
      run.state === 'handed_off' &&
      run.next?.target?.kind === 'question' &&
      run.next.target.id === input.questionId,
  );
  if (!waiting) return null;
  const result = await resumeStepRun(
    {
      userId: input.userId,
      workId: input.workId,
      runId: waiting.id,
      note: `The user answered: ${input.answer}`,
    },
    deps,
  ).catch(() => null);
  return result?.runId ?? null;
}

/**
 * The automatic trigger: try the current step of each Work, in order, and
 * stop after the first run that starts (one automatic run per user at a time).
 */
export async function startAutomaticRuns(
  input: { userId: string; workIds: string[]; trigger: 'brief' | 'conductor' },
  overrides: Partial<StepRunStartDependencies> = {},
): Promise<{ started: string[]; reasons: Record<string, string> }> {
  const started: string[] = [];
  const reasons: Record<string, string> = {};
  if (!automaticStepRunsEnabledFor(input.userId)) {
    for (const workId of input.workIds) reasons[workId] = 'auto_off';
    return { started, reasons };
  }
  for (const workId of [...new Set(input.workIds)].slice(0, 12)) {
    try {
      const result = await startStepRun({ userId: input.userId, workId, trigger: input.trigger }, overrides);
      if (result.created && result.runId) {
        started.push(result.runId);
        break;
      }
      reasons[workId] = result.reason || 'not_started';
      if (result.reason === 'busy' || result.reason === 'paused' || result.reason === 'auto_off') break;
    } catch (error) {
      reasons[workId] = error instanceof Error ? error.name : 'error';
    }
  }
  return { started, reasons };
}

export type HandleStepAction = 'started' | 'resumed' | 'steered' | 'working';

/**
 * The thread's one control for runs (docs/albatross-thread.md, "One voice,
 * background runs"). With a run open, the note goes to that run (or, with no
 * note, nothing changes). With a handoff waiting on the step, the run
 * continues with the note, and a question it asked counts as answered by the
 * chat. Otherwise a new run starts with the note.
 */
export async function handleStepFromThread(
  input: { userId: string; workId: string; stepKey?: string; note?: string },
  overrides: Partial<StepRunStartDependencies> = {},
): Promise<{ action: HandleStepAction; runId: string }> {
  const deps = { ...defaults, ...overrides };
  if (!stepRunsEnabled()) throw new StepRunStartError('Step runs are off.', 403);
  const note = input.note?.trim() || '';
  const runs = await deps.convexQuery<any[]>(api.albatrossStepRuns.runsForWorkHistory, {
    userId: input.userId,
    workId: input.workId,
  });
  const newestFirst = [...(runs || [])].reverse();
  const open = newestFirst.find((run) => run.state === 'queued' || run.state === 'running');
  if (open) {
    if (!note) return { action: 'working', runId: open.id };
    const steered = await deps.convexMutation<boolean>(api.albatrossStepRuns.steer, {
      userId: input.userId,
      id: open.id,
      text: note,
    });
    if (steered) return { action: 'steered', runId: open.id };
  }
  // Only the newest run of the target step can continue: an older handoff (its
  // continuation already ran) or another step's handoff is not the one waiting.
  const targetStepKey = input.stepKey ?? (await loadStep(deps, input.userId, input.workId)).step?.key;
  const newest = targetStepKey ? newestFirst.find((run) => run.stepKey === targetStepKey) : undefined;
  const waiting = newest?.state === 'handed_off' ? newest : undefined;
  if (waiting) {
    const questionId = waiting.next?.target?.kind === 'question' ? waiting.next.target.id : null;
    if (questionId && note && waiting.question?.status === 'pending') {
      // The chat answered the run's question; the form shows it as answered.
      await deps
        .convexMutation(api.albatrossWorkV2.answerQuestion, {
          userId: input.userId,
          questionId,
          expectedWorkId: input.workId,
          answer: truncateText(`${CHAT_ANSWER_PREFIX}${note}`, 2_000),
        })
        .catch(() => undefined);
    }
    const resumed = await resumeStepRun(
      { userId: input.userId, workId: input.workId, runId: waiting.id, note: note || undefined },
      deps,
    );
    if (!resumed.runId) throw new StepRunStartError('The run could not continue now. Try again.', 409);
    return { action: 'resumed', runId: resumed.runId };
  }
  const started = await startStepRun(
    {
      userId: input.userId,
      workId: input.workId,
      stepKey: input.stepKey,
      trigger: 'user',
      note: note || undefined,
    },
    deps,
  );
  if (!started.runId) throw new StepRunStartError('The run did not start. Try again.', 409);
  return { action: 'started', runId: started.runId };
}

/** Stop the open run of a Work from the thread. Returns the stopped run id, or null. */
export async function stopStepFromThread(
  input: { userId: string; workId: string },
  overrides: Partial<StepRunStartDependencies> = {},
): Promise<string | null> {
  const deps = { ...defaults, ...overrides };
  const runs = await deps.convexQuery<any[]>(api.albatrossStepRuns.runsForWorkHistory, {
    userId: input.userId,
    workId: input.workId,
  });
  const open = [...(runs || [])].reverse().find((run) => run.state === 'queued' || run.state === 'running');
  if (!open) return null;
  const cancelled = await deps.convexMutation<{ cancelled: boolean; browserSessionId: string | null }>(
    api.albatrossStepRuns.cancel,
    { userId: input.userId, id: open.id },
  );
  // The page goes to the user at once, as with "Take over".
  if (cancelled?.browserSessionId)
    await deps
      .convexMutation(api.albatrossBrowserSessions.setSessionStatus, {
        userId: input.userId,
        sessionId: cancelled.browserSessionId,
        status: 'user',
        statusDetail: 'You have the page.',
      })
      .catch(() => undefined);
  return open.id;
}
