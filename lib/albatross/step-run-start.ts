// Starting step runs: from the user ("Handle it", "Continue"), from an
// answered question, and from the automatic triggers (the Brief and the
// conductor). Convex owns the queue rules (one open run per Work, one
// automatic run per step); this module owns the switches, the standing
// order, and the step check.

import { api, convexMutation, convexQuery } from '../hosted/convex';
import { isStandingOrderPaused } from '../hosted/standing-orders';
import {
  automaticStepRunsEnabledFor,
  isAutomaticTrigger,
  type RunnableStepLike,
  stepAcceptsTrigger,
  stepRunsEnabled,
} from './step-run-policy';

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
  input: { userId: string; workId: string; stepKey?: string; trigger: 'user' | 'brief' | 'conductor' },
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
