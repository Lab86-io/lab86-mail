// Switches, limits, and eligibility for step runs (docs/albatross-step-runner.md).
//
// LAB86_STEP_RUNS=off turns the feature off. Runs that the user starts are on
// by default. Automatic runs (the Brief and the conductor) are off until
// LAB86_STEP_RUNS_AUTO is `all` or a comma-separated list of user ids: risky
// changes ship dark and turn on for one account first.

import { normalizeStepMode, type StepMode, stepModeAcceptsRun, stepModeRunsAlone } from './step-contract';

export const DEFAULT_STEP_RUN_TIME_BUDGET_MS = 15 * 60_000;
export const DEFAULT_STEP_RUN_COST_BUDGET_USD = 5;
/** Model steps in one run. The time and cost budgets stop a run long before a loop does. */
export const STEP_RUN_MAX_MODEL_STEPS = 60;
/** A user run that takes longer than this notifies the user at its handoff. */
export const STEP_RUN_NOTIFY_AFTER_MS = 60_000;

type Env = Record<string, string | undefined>;

function positiveNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function stepRunsEnabled(env: Env = process.env): boolean {
  return (env.LAB86_STEP_RUNS || '').trim().toLowerCase() !== 'off';
}

export function automaticStepRunsEnabledFor(userId: string, env: Env = process.env): boolean {
  if (!stepRunsEnabled(env)) return false;
  const raw = (env.LAB86_STEP_RUNS_AUTO || '').trim();
  if (!raw) return false;
  if (raw.toLowerCase() === 'all') return true;
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .includes(userId);
}

export function stepRunLimits(env: Env = process.env) {
  return {
    timeBudgetMs: positiveNumber(env.LAB86_STEP_RUN_TIME_BUDGET_MS, DEFAULT_STEP_RUN_TIME_BUDGET_MS),
    costBudgetUsd: positiveNumber(env.LAB86_STEP_RUN_COST_BUDGET_USD, DEFAULT_STEP_RUN_COST_BUDGET_USD),
  };
}

export type StepRunTrigger = 'user' | 'brief' | 'conductor' | 'resume';

export function isAutomaticTrigger(trigger: StepRunTrigger) {
  return trigger === 'brief' || trigger === 'conductor';
}

/** The model feature: a user run is metered like chat; an automatic run like background work. */
export function stepRunFeature(trigger: StepRunTrigger): 'albatross_step' | 'albatross_step_auto' {
  return isAutomaticTrigger(trigger) ? 'albatross_step_auto' : 'albatross_step';
}

export interface RunnableStepLike {
  key: string;
  identity?: string;
  title: string;
  kind?: string | null;
  done: boolean;
  stepMode?: string | null;
}

/** May this trigger start a run on this step? */
export function stepAcceptsTrigger(step: RunnableStepLike, trigger: StepRunTrigger): boolean {
  if (step.done) return false;
  const mode: StepMode | undefined = normalizeStepMode(step.stepMode);
  if (isAutomaticTrigger(trigger)) return stepModeRunsAlone(mode);
  return stepModeAcceptsRun(mode, step.kind);
}
