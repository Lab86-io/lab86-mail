import { AsyncLocalStorage } from 'node:async_hooks';
import { type AiUsageCostInput, estimateAiUsageCost } from '../ai/budget';

// The edition budget (FEATURES item 5). Each edition gets a time budget
// (default 10 minutes of writer time, summed over its attempts) and a cost
// budget (default $2.00 of model cost, also summed over its attempts). The
// meter counts every model step that runs inside the edition. When a budget
// runs out, the meter stops the running model call and refuses new ones, so
// the writers fall back and the edition publishes what exists. The record
// goes onto the edition and into the telemetry table.
//
// Writer time is the time while at least one model call of the edition is
// open. The source refresh and the candidate scan before the writers do not
// count. Before 2026-09-28 the clock ran from the start of the edition: on a
// large account the scan used the full 10 minutes, and the Opus edition
// published with no writer call at all (telemetry: 907 s, 0 calls).
//
// The cost budget is a safety stop for a runaway writer (the layout loop has
// no step limit), not a limit on a normal edition. Briefs keep the user's
// model (owner decision, 2026-09-27). On gpt-5.5 or opus-5.5 a normal edition
// (the prose call plus the layout loop) costs about $0.40 to $1.60 at list
// prices, so the old $0.40 stopped normal editions and their retries.

export const DEFAULT_BRIEF_TIME_BUDGET_MS = 10 * 60_000;
export const DEFAULT_BRIEF_COST_BUDGET_USD = 2;

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
  /** Model calls open now. The writer clock runs while this is above 0. */
  private openCalls = 0;
  private openSince = 0;
  /** Writer time of this attempt from calls that closed. */
  private closedMs = 0;
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

  /**
   * Opens one model call. The first open call starts the writer clock and the
   * timer that stops the edition when its writer time runs out.
   */
  openCall() {
    this.assertOpen();
    this.openCalls += 1;
    if (this.openCalls > 1) return;
    this.openSince = this.now();
    this.timer = setTimeout(() => this.stop('time'), Math.max(0, this.timeBudgetMs - this.elapsedMs()));
    // A pending budget timer must never keep a finished process alive.
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Closes one model call. The last closed call stops the writer clock. */
  closeCall() {
    if (this.openCalls === 0) return;
    this.openCalls -= 1;
    if (this.openCalls > 0) return;
    this.closedMs += Math.max(0, this.now() - this.openSince);
    this.finish();
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

  /** Writer time of all attempts: closed calls, plus the open interval. */
  elapsedMs() {
    const open = this.openCalls > 0 ? Math.max(0, this.now() - this.openSince) : 0;
    return this.prior.timeMs + this.closedMs + open;
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
 * Runs one model call. Inside an edition, the writer clock runs while the call
 * is open; outside an edition the call runs as it is.
 */
export async function withMeteredModelCall<T>(call: () => Promise<T>): Promise<T> {
  const meter = currentBriefMeter();
  if (!meter) return call();
  meter.openCall();
  try {
    return await call();
  } finally {
    meter.closeCall();
  }
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
