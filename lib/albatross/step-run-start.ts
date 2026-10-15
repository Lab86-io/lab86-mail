// Starting step runs: from the user ("Handle it", "Continue"), from an
// answered question, and from the automatic triggers (the Brief and the
// conductor). Convex owns the queue rules (one open run per Work, one
// automatic run per step); this module owns the switches, the standing
// order, and the step check.

import { api, convexMutation, convexQuery } from '../hosted/convex';
import { isStandingOrderPaused } from '../hosted/standing-orders';
import { resolveBriefTimezone } from '../mail/brief-timezone';
import { truncateText } from '../shared/text';
import { GOAL_STEP_KEY, goalAutoIdentity, goalRunsEnabled, goalStepIdentity } from './goal-run-contract';
import { goalAutoVerdict, isGoalRun, seedChecklist, userDidPartNote } from './goal-runs';
import { localDateKey } from './local-time';
import { normalizeStepMode, stepModeRunsAlone } from './step-contract';
import { completeWorkStep } from './step-execution';
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
  completeWorkStep: typeof completeWorkStep;
  /** The user's time zone, for the day key of automatic goal runs. */
  timezone: (userId: string) => Promise<string | undefined>;
}

const defaults: StepRunStartDependencies = {
  convexQuery,
  convexMutation,
  runsPaused: (userId) => isStandingOrderPaused(userId, 'runs'),
  completeWorkStep: (input) => completeWorkStep(input),
  timezone: (userId) => resolveBriefTimezone(userId, undefined),
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

// ---------------------------------------------------------------------------
// Goal runs (docs/albatross-goal-runs.md): a run works on the whole goal, so
// it needs no step. For a user in LAB86_GOAL_RUNS every run is a goal run.
// ---------------------------------------------------------------------------

type HistoryRun = {
  id: string;
  state: string;
  goal?: boolean;
  stepKey?: string;
  outcome?: string | null;
  stoppedBy?: string | null;
  browserSessionId?: string | null;
  checklist?: Array<{ text: string; state: string }>;
  next?: { label?: string; target?: { kind?: string; id?: string } | null } | null;
  question?: { status?: string } | null;
};

async function loadGoalWork(deps: StepRunStartDependencies, userId: string, workId: string) {
  const detail = await deps.convexQuery<any>(api.albatrossWorkV2.workDetail, { userId, workId });
  if (!detail?.work) return null;
  const runs = await deps
    .convexQuery<HistoryRun[]>(api.albatrossStepRuns.runsForWorkHistory, { userId, workId })
    .then((rows) => rows || [])
    .catch(() => [] as HistoryRun[]);
  return { detail, runs };
}

/** The run title of a goal: the Work's title. */
function goalTitle(detail: any): string {
  return (
    truncateText(
      String(detail?.work?.title || detail?.work?.rawText || '')
        .replace(/\s+/g, ' ')
        .trim(),
      200,
    ) || 'Albatross'
  );
}

/** The user's local date for the automatic day key. A bad time zone counts as UTC. */
function localDate(timezone: string | undefined, at = new Date()): string {
  try {
    return localDateKey(timezone || 'UTC', at);
  } catch {
    return localDateKey('UTC', at);
  }
}

function enqueueRefusal(result: EnqueueResult, fallback: string): never {
  if (result.reason === 'active') throw new StepRunStartError('Albatross is already working on this.', 409);
  if (result.reason === 'busy')
    throw new StepRunStartError('Albatross has 30 steps open or waiting now. Try again when one ends.', 409);
  if (result.reason === 'closed') throw new StepRunStartError('This Albatross is closed.', 409);
  throw new StepRunStartError(fallback, 409);
}

/**
 * Start a goal run. The user starts one at any time ("Handle it"). An
 * automatic trigger starts one only for a Work with no run yet, or whose
 * newest run stopped at its limit, at most once a day for each Work (G1).
 */
async function startGoalRun(
  input: { userId: string; workId: string; trigger: 'user' | 'brief' | 'conductor'; note?: string },
  deps: StepRunStartDependencies,
): Promise<StartResult> {
  const automatic = isAutomaticTrigger(input.trigger);
  const loaded = await loadGoalWork(deps, input.userId, input.workId);
  if (!loaded) {
    if (automatic) return { runId: null, created: false, reason: 'no_work' };
    throw new StepRunStartError('Albatross Work not found.', 404);
  }
  const { detail, runs } = loaded;
  let stepIdentity = goalStepIdentity(input.workId);
  let parent: HistoryRun | undefined;
  if (automatic) {
    const verdict = goalAutoVerdict({
      runs,
      pendingQuestions: (detail.questions || []).filter((question: any) => question?.status === 'pending')
        .length,
    });
    if (!verdict.start) return { runId: null, created: false, reason: verdict.reason };
    const timezone = await deps.timezone(input.userId).catch(() => undefined);
    stepIdentity = goalAutoIdentity(input.workId, localDate(timezone));
    parent = verdict.continueFrom ? runs.find((run) => run.id === verdict.continueFrom) : undefined;
  }
  const result = await deps.convexMutation<EnqueueResult>(api.albatrossStepRuns.enqueue, {
    userId: input.userId,
    workId: input.workId,
    stepKey: GOAL_STEP_KEY,
    stepIdentity,
    stepTitle: goalTitle(detail),
    trigger: input.trigger,
    goal: true,
    checklist: seedChecklist({ runs, steps: detail.execution?.guideSteps }),
    ...(parent ? { parentRunId: parent.id } : {}),
    ...(parent?.browserSessionId ? { browserSessionId: parent.browserSessionId } : {}),
    ...(!automatic && input.note?.trim() ? { resumeNote: input.note.trim() } : {}),
  });
  if (!automatic && !result.created) enqueueRefusal(result, 'The run did not start. Try again.');
  return result;
}

/** Continue a goal (or, in goal mode, any) handoff as a goal run. */
async function resumeGoalRun(
  input: { userId: string; workId: string; parent: HistoryRun; note?: string },
  deps: StepRunStartDependencies,
): Promise<StartResult> {
  const loaded = await loadGoalWork(deps, input.userId, input.workId);
  if (!loaded) throw new StepRunStartError('Albatross Work not found.', 404);
  const result = await deps.convexMutation<EnqueueResult>(api.albatrossStepRuns.enqueue, {
    userId: input.userId,
    workId: input.workId,
    stepKey: GOAL_STEP_KEY,
    stepIdentity: goalStepIdentity(input.workId),
    stepTitle: goalTitle(loaded.detail),
    trigger: 'resume',
    goal: true,
    checklist: seedChecklist({
      runs: [...loaded.runs.filter((run) => run.id !== input.parent.id), input.parent],
      steps: loaded.detail.execution?.guideSteps,
    }),
    parentRunId: input.parent.id,
    ...(input.note?.trim() ? { resumeNote: input.note.trim() } : {}),
    ...(input.parent.browserSessionId ? { browserSessionId: input.parent.browserSessionId } : {}),
  });
  if (!result.created) enqueueRefusal(result, 'The run could not continue now. Try again.');
  return result;
}

/**
 * "Done, continue" on a goal handoff: the user did their part. The handoff
 * closes, and a new goal run checks the contract first. The Work closes only
 * by its contract, never by this tap. The result has the shape of a step
 * check, so the clients read one shape.
 */
export async function continueGoalRun(
  input: { userId: string; workId: string; note?: string },
  overrides: Partial<StepRunStartDependencies> = {},
): Promise<StepCheckResult> {
  const deps = { ...defaults, ...overrides };
  if (!stepRunsEnabled()) throw new StepRunStartError('Step runs are off.', 403);
  const runs = await deps
    .convexQuery<HistoryRun[]>(api.albatrossStepRuns.runsForWorkHistory, {
      userId: input.userId,
      workId: input.workId,
    })
    .then((rows) => rows || []);
  const newest = runs.at(-1);
  if (
    !newest ||
    newest.state !== 'handed_off' ||
    !isGoalRun(newest) ||
    (newest.outcome !== 'ready_for_you' && newest.outcome !== 'your_turn')
  )
    throw new StepRunStartError('Nothing waits for you on this Albatross.', 409);
  const started = await resumeGoalRun(
    {
      userId: input.userId,
      workId: input.workId,
      parent: newest,
      note: userDidPartNote(newest.next?.label, input.note),
    },
    deps,
  );
  await deps
    .convexMutation(api.albatrossStepRuns.dismissHandoff, { userId: input.userId, id: newest.id })
    .catch(() => undefined);
  return {
    stepKey: GOAL_STEP_KEY,
    allStepsComplete: false,
    nextRunId: started.runId,
    nextStepKey: GOAL_STEP_KEY,
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
  // Goal mode: the run works on the whole goal; a step key, if any, is ignored.
  if (goalRunsEnabled(input.userId)) return startGoalRun(input, deps);
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
      throw new StepRunStartError(
        'Albatross has 30 steps open or waiting now. Try again when one ends.',
        409,
      );
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
  // A goal handoff continues as a goal run; in goal mode, so does a step handoff.
  if (isGoalRun(parent) || goalRunsEnabled(input.userId))
    return resumeGoalRun({ userId: input.userId, workId: input.workId, parent, note: input.note }, deps);
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
    if (result.reason === 'busy')
      throw new StepRunStartError(
        'Albatross has 30 steps open or waiting now. Try again when one ends.',
        409,
      );
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

export type HandleStepAction = 'started' | 'resumed' | 'steered' | 'working' | 'checked';

/**
 * The thread's one control for runs (docs/albatross-thread.md, "One voice,
 * background runs"). With a run open, the note goes to that run (or, with no
 * note, nothing changes). With a handoff waiting on the step, the run
 * continues with the note, and a question it asked counts as answered by the
 * chat. Otherwise a new run starts with the note.
 */
export async function handleStepFromThread(
  input: { userId: string; workId: string; stepKey?: string; note?: string; done?: boolean },
  overrides: Partial<StepRunStartDependencies> = {},
): Promise<{ action: HandleStepAction; runId: string | null; check?: StepCheckResult; goal?: boolean }> {
  const deps = { ...defaults, ...overrides };
  const note = input.note?.trim() || '';
  if (goalRunsEnabled(input.userId)) {
    const handled = await handleGoalFromThread({ ...input, note }, deps);
    if (handled) return handled;
  }
  // The user says the step is done: their word checks it. A run never does the
  // step again to prove what the user already said.
  if (input.done) {
    const check = await completeStepAndContinue(
      { userId: input.userId, workId: input.workId, stepKey: input.stepKey, note: note || undefined },
      deps,
    );
    return { action: 'checked', runId: check.nextRunId, check };
  }
  if (!stepRunsEnabled()) throw new StepRunStartError('Step runs are off.', 403);
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

/**
 * The thread control in goal mode. With a run open, the note goes to it. A
 * handoff that waits continues as a goal run ("done" is "Done, continue").
 * Otherwise a goal run starts. Null: the user marks an old plan step done
 * and no goal handoff waits, which the step path handles.
 */
async function handleGoalFromThread(
  input: { userId: string; workId: string; note: string; done?: boolean },
  deps: StepRunStartDependencies,
): Promise<{ action: HandleStepAction; runId: string | null; check?: StepCheckResult; goal: true } | null> {
  if (!stepRunsEnabled()) throw new StepRunStartError('Step runs are off.', 403);
  const runs =
    (await deps.convexQuery<HistoryRun[]>(api.albatrossStepRuns.runsForWorkHistory, {
      userId: input.userId,
      workId: input.workId,
    })) || [];
  const newest = runs.at(-1);
  const open = [...runs].reverse().find((run) => run.state === 'queued' || run.state === 'running');
  if (open) {
    const text = input.done
      ? `The user says this part is done.${input.note ? ` ${input.note}` : ''}`
      : input.note;
    if (!text) return { action: 'working', runId: open.id, goal: true };
    const steered = await deps.convexMutation<boolean>(api.albatrossStepRuns.steer, {
      userId: input.userId,
      id: open.id,
      text,
    });
    if (steered) return { action: 'steered', runId: open.id, goal: true };
  }
  const waiting = newest?.state === 'handed_off' ? newest : undefined;
  if (input.done) {
    if (!waiting || !isGoalRun(waiting)) return null;
    const check = await continueGoalRun(
      { userId: input.userId, workId: input.workId, note: input.note },
      deps,
    );
    return { action: 'resumed', runId: check.nextRunId, check, goal: true };
  }
  if (waiting) {
    const questionId = waiting.next?.target?.kind === 'question' ? waiting.next.target.id : null;
    if (questionId && input.note && waiting.question?.status === 'pending') {
      await deps
        .convexMutation(api.albatrossWorkV2.answerQuestion, {
          userId: input.userId,
          questionId,
          expectedWorkId: input.workId,
          answer: truncateText(`${CHAT_ANSWER_PREFIX}${input.note}`, 2_000),
        })
        .catch(() => undefined);
    }
    const resumed = await resumeGoalRun(
      { userId: input.userId, workId: input.workId, parent: waiting, note: input.note || undefined },
      deps,
    );
    return { action: 'resumed', runId: resumed.runId, goal: true };
  }
  const started = await startGoalRun(
    { userId: input.userId, workId: input.workId, trigger: 'user', note: input.note || undefined },
    deps,
  );
  return { action: 'started', runId: started.runId, goal: true };
}

export interface StepCheckResult {
  stepKey: string;
  allStepsComplete: boolean;
  /** The run that started on the next step, or null when the next step stays with the user. */
  nextRunId: string | null;
  nextStepKey: string | null;
}

/**
 * The user marks a step done (docs/albatross-document-handoff.md): the step is
 * checked with the user's word, its handoffs close, and Albatross starts the
 * next step when that step is one it does alone. A step that stays with the
 * user, a closed Work, or runs that are off end the chain without an error.
 */
export async function completeStepAndContinue(
  input: {
    userId: string;
    userEmail?: string | null;
    userName?: string | null;
    workId: string;
    stepKey?: string;
    note?: string;
    timezone?: string;
  },
  overrides: Partial<StepRunStartDependencies> = {},
): Promise<StepCheckResult> {
  const deps = { ...defaults, ...overrides };
  const completed = await deps.completeWorkStep({
    userId: input.userId,
    userEmail: input.userEmail,
    userName: input.userName,
    workId: input.workId,
    stepKey: input.stepKey,
    timezone: input.timezone,
    source: 'user',
    note: input.note,
  });
  const result: StepCheckResult = {
    stepKey: completed.stepKey,
    allStepsComplete: completed.allStepsComplete,
    nextRunId: null,
    nextStepKey: null,
  };
  if (completed.closed || !stepRunsEnabled()) return result;
  // Goal mode: Albatross goes on with the whole goal, not with the next step.
  if (goalRunsEnabled(input.userId)) {
    const started = await startGoalRun(
      { userId: input.userId, workId: input.workId, trigger: 'user' },
      deps,
    ).catch(() => null);
    result.nextRunId = started?.runId ?? null;
    result.nextStepKey = started?.runId ? GOAL_STEP_KEY : null;
    return result;
  }
  if (completed.allStepsComplete) return result;
  const { step } = await loadStep(deps, input.userId, input.workId).catch(() => ({ step: null }));
  if (!step || step.done) return result;
  result.nextStepKey = step.key;
  if (!stepModeRunsAlone(normalizeStepMode(step.stepMode)) || !stepAcceptsTrigger(step, 'user'))
    return result;
  const started = await startStepRun(
    { userId: input.userId, workId: input.workId, stepKey: step.key, trigger: 'user' },
    deps,
  ).catch(() => null);
  result.nextRunId = started?.runId ?? null;
  return result;
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
