import { AsyncLocalStorage } from 'node:async_hooks';
import { type AiUsageCostInput, estimateAiUsageCost } from '../ai/budget';

// The edition budget (FEATURES item 5). Each edition gets a time budget
// (default 10 minutes of writer time, summed over its attempts) and a cost
// budget (default $0.40 of model cost). The meter counts every model step
// that runs inside the edition. When a budget runs out, the meter stops the
// running model call and refuses new ones, so the writers fall back and the
// edition publishes what exists. The record goes onto the edition and into
// the telemetry table.

export const DEFAULT_BRIEF_TIME_BUDGET_MS = 10 * 60_000;
export const DEFAULT_BRIEF_COST_BUDGET_USD = 0.4;

export type BriefBudgetLimit = 'time' | 'cost';

export interface BriefEditionBudget {
  /** Writer time used by all attempts so far. */
  timeMs: number;
  /** Estimated model cost in US dollars. */
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** Model steps counted. */
  calls: number;
  /** The budget that ran out, or null. */
  exhausted: BriefBudgetLimit | null;
  /** The edition published without its written layout. */
  fallback: boolean;
  timeBudgetMs: number;
  costBudgetUsd: number;
}

function positiveNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function briefBudgetLimits(env: Record<string, string | undefined> = process.env) {
  return {
    timeBudgetMs: positiveNumber(env.LAB86_BRIEF_TIME_BUDGET_MS, DEFAULT_BRIEF_TIME_BUDGET_MS),
    costBudgetUsd: positiveNumber(env.LAB86_BRIEF_COST_BUDGET_USD, DEFAULT_BRIEF_COST_BUDGET_USD),
  };
}

export class BriefBudgetExhaustedError extends Error {
  constructor(readonly limit: BriefBudgetLimit) {
    super(
      limit === 'time'
        ? 'The edition used its writer time. It was published with what was ready.'
        : 'The edition used its model budget. It was published with what was ready.',
    );
    this.name = 'BriefBudgetExhaustedError';
  }
}

export interface BriefUsageStep {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

export class BriefEditionMeter {
  readonly timeBudgetMs: number;
  readonly costBudgetUsd: number;
  private readonly controller = new AbortController();
  private readonly startedAt: number;
  private readonly prior: Pick<
    BriefEditionBudget,
    'timeMs' | 'costUsd' | 'inputTokens' | 'outputTokens' | 'calls'
  >;
  private costUsd = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private calls = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;
  exhausted: BriefBudgetLimit | null = null;

  constructor(
    options: {
      prior?: Partial<BriefEditionBudget> | null;
      timeBudgetMs?: number;
      costBudgetUsd?: number;
      now?: () => number;
    } = {},
  ) {
    const limits = briefBudgetLimits();
    this.timeBudgetMs = options.timeBudgetMs ?? limits.timeBudgetMs;
    this.costBudgetUsd = options.costBudgetUsd ?? limits.costBudgetUsd;
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    this.prior = {
      timeMs: Math.max(0, Number(options.prior?.timeMs) || 0),
      costUsd: Math.max(0, Number(options.prior?.costUsd) || 0),
      inputTokens: Math.max(0, Number(options.prior?.inputTokens) || 0),
      outputTokens: Math.max(0, Number(options.prior?.outputTokens) || 0),
      calls: Math.max(0, Number(options.prior?.calls) || 0),
    };
    if (this.prior.costUsd >= this.costBudgetUsd) this.stop('cost');
    else if (this.prior.timeMs >= this.timeBudgetMs) this.stop('time');
  }

  get signal() {
    return this.controller.signal;
  }

  /** Starts the clock that stops the edition at its time budget. */
  start() {
    if (this.exhausted || this.timer) return this;
    const left = this.timeBudgetMs - this.prior.timeMs;
    this.timer = setTimeout(() => this.stop('time'), Math.max(0, left));
    // A pending budget timer must never keep a finished process alive.
    (this.timer as { unref?: () => void }).unref?.();
    return this;
  }

  finish() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private stop(limit: BriefBudgetLimit) {
    if (this.exhausted) return;
    this.exhausted = limit;
    this.finish();
    this.controller.abort(new BriefBudgetExhaustedError(limit));
  }

  /** Throws when the edition may not start another model call. */
  assertOpen() {
    if (!this.exhausted && this.elapsedMs() >= this.timeBudgetMs) this.stop('time');
    if (this.exhausted) throw new BriefBudgetExhaustedError(this.exhausted);
  }

  elapsedMs() {
    return this.prior.timeMs + Math.max(0, this.now() - this.startedAt);
  }

  /** Counts one model step at the model's prices. */
  addStep(runtime: { provider: string; modelName: string }, usage: BriefUsageStep | undefined) {
    const inputTokens = Math.max(0, Number(usage?.inputTokens) || 0);
    const outputTokens = Math.max(0, Number(usage?.outputTokens) || 0);
    const { estimatedCostUsd } = estimateAiUsageCost({
      provider: runtime.provider as AiUsageCostInput['provider'],
      model: runtime.modelName,
      promptTokens: inputTokens,
      completionTokens: outputTokens,
      cachedInputTokens: Math.max(0, Number(usage?.cachedInputTokens) || 0),
    });
    this.calls += 1;
    this.inputTokens += inputTokens;
    this.outputTokens += outputTokens;
    this.costUsd += Number.isFinite(estimatedCostUsd) ? estimatedCostUsd : 0;
    if (this.prior.costUsd + this.costUsd >= this.costBudgetUsd) this.stop('cost');
  }

  record(fallback: boolean): BriefEditionBudget {
    return {
      timeMs: Math.round(this.elapsedMs()),
      costUsd: Math.round((this.prior.costUsd + this.costUsd) * 1_000_000) / 1_000_000,
      inputTokens: this.prior.inputTokens + this.inputTokens,
      outputTokens: this.prior.outputTokens + this.outputTokens,
      calls: this.prior.calls + this.calls,
      exhausted: this.exhausted,
      fallback,
      timeBudgetMs: this.timeBudgetMs,
      costBudgetUsd: this.costBudgetUsd,
    };
  }
}

const meterStorage = new AsyncLocalStorage<BriefEditionMeter>();

/** Runs `fn` with the meter counting every model step inside it. */
export async function runWithBriefMeter<T>(meter: BriefEditionMeter, fn: () => Promise<T>): Promise<T> {
  meter.start();
  try {
    return await meterStorage.run(meter, fn);
  } finally {
    meter.finish();
  }
}

export function currentBriefMeter(): BriefEditionMeter | undefined {
  return meterStorage.getStore();
}

/**
 * The generate options with the edition meter attached: the edition's abort
 * signal beside the caller's, and a step counter before the caller's own. A
 * call outside an edition gets its options back unchanged. The gateway calls
 * this for every attempt.
 */
export function meterGenerateOptions<T extends Record<string, any>>(
  options: T,
  runtime: { provider: string; modelName: string },
): T {
  const meter = currentBriefMeter();
  if (!meter) return options;
  meter.assertOpen();
  const signals = [options.abortSignal, meter.signal].filter(Boolean) as AbortSignal[];
  const onStepFinish = options.onStepFinish;
  return {
    ...options,
    abortSignal: signals.length > 1 ? AbortSignal.any(signals) : meter.signal,
    onStepFinish: async (step: { usage?: BriefUsageStep }) => {
      meter.addStep(runtime, step?.usage);
      if (typeof onStepFinish === 'function') await onStepFinish(step);
    },
  };
}

export function isBriefBudgetExhausted(error: unknown): boolean {
  return error instanceof BriefBudgetExhaustedError;
}

/** A stored budget record, or undefined for anything else. */
export function parseBriefEditionBudget(value: unknown): BriefEditionBudget | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const number = (key: string) => (Number.isFinite(Number(raw[key])) ? Math.max(0, Number(raw[key])) : 0);
  const limits = briefBudgetLimits();
  return {
    timeMs: number('timeMs'),
    costUsd: number('costUsd'),
    inputTokens: number('inputTokens'),
    outputTokens: number('outputTokens'),
    calls: number('calls'),
    exhausted: raw.exhausted === 'time' || raw.exhausted === 'cost' ? raw.exhausted : null,
    fallback: raw.fallback === true,
    timeBudgetMs: number('timeBudgetMs') || limits.timeBudgetMs,
    costBudgetUsd: number('costBudgetUsd') || limits.costBudgetUsd,
  };
}
