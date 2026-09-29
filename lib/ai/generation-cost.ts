import { AsyncLocalStorage } from 'node:async_hooks';

// The cost of a model call that failed or stopped. Before 2026-09-28 a failed
// call recorded no usage and no cost, so about 60% of the OpenRouter spend
// was missing from aiUsageEvents and from the cost alarm.
//
// Two sources give the cost. A schema failure (NoObjectGeneratedError) keeps
// the token usage of its response. Every OpenRouter response also sends an
// `x-generation-id` header before its body, so a call that stopped before
// its body still has an id; GET /api/v1/generation?id=<id> gives its real
// cost a few seconds later. The lookup runs after the caller continues, so a
// user never waits for it.

const OPENROUTER_GENERATION_URL = 'https://openrouter.ai/api/v1/generation';
/** Waits before each lookup round. The provider needs a few seconds after a call. */
export const GENERATION_LOOKUP_DELAYS_MS = [3_000, 10_000, 30_000];
/** The time limit of one lookup request. A request that hangs must not stop the usage record. */
export const GENERATION_LOOKUP_TIMEOUT_MS = 10_000;

/** The OpenRouter generation ids of the requests that one model call sent. */
export interface GenerationCapture {
  ids: string[];
}

const captureStorage = new AsyncLocalStorage<GenerationCapture>();

export function newGenerationCapture(): GenerationCapture {
  return { ids: [] };
}

/** Runs `fn` and notes in `capture` the generation id of each OpenRouter request it sends. */
export function runWithGenerationCapture<T>(capture: GenerationCapture, fn: () => T): T {
  return captureStorage.run(capture, fn);
}

/**
 * A fetch for the OpenRouter client that notes the generation id of each
 * response. With no `base`, it reads the global fetch at each call.
 */
export function captureGenerationIdFetch(
  base?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await (base ?? globalThis.fetch)(input, init);
    const id = response.headers.get('x-generation-id');
    if (id) captureStorage.getStore()?.ids.push(id);
    return response;
  }) as typeof fetch;
}

export interface GenerationCost {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

interface LookupOptions {
  apiKey: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  delaysMs?: readonly number[];
  /** The time limit of each lookup request. Default GENERATION_LOOKUP_TIMEOUT_MS. */
  timeoutMs?: number;
}

/** The cost of one generation, or null when OpenRouter has no record of it yet. */
export async function readGenerationCost(id: string, options: LookupOptions): Promise<GenerationCost | null> {
  const response = await (options.fetch ?? globalThis.fetch)(
    `${OPENROUTER_GENERATION_URL}?id=${encodeURIComponent(id)}`,
    {
      headers: { Authorization: `Bearer ${options.apiKey}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? GENERATION_LOOKUP_TIMEOUT_MS),
    },
  );
  if (!response.ok) return null;
  const data = ((await response.json().catch(() => null)) as { data?: Record<string, unknown> } | null)?.data;
  const costUsd = Number(data?.total_cost);
  if (!data || !Number.isFinite(costUsd) || costUsd < 0) return null;
  const tokens = (native: unknown, normalized: unknown) => Math.max(0, Number(native ?? normalized) || 0);
  return {
    costUsd,
    inputTokens: tokens(data.native_tokens_prompt, data.tokens_prompt),
    outputTokens: tokens(data.native_tokens_completion, data.tokens_completion),
  };
}

/**
 * The summed cost of the generations. Each round waits, then reads the ids
 * that have no cost yet. Null when no id got a cost.
 */
export async function lookupGenerationCosts(
  ids: readonly string[],
  options: LookupOptions,
): Promise<GenerationCost | null> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pending = new Set(ids);
  const total: GenerationCost = { costUsd: 0, inputTokens: 0, outputTokens: 0 };
  let found = 0;
  for (const delay of options.delaysMs ?? GENERATION_LOOKUP_DELAYS_MS) {
    if (!pending.size) break;
    await sleep(delay);
    for (const id of [...pending]) {
      const cost = await readGenerationCost(id, options).catch(() => null);
      if (!cost) continue;
      pending.delete(id);
      found += 1;
      total.costUsd += cost.costUsd;
      total.inputTokens += cost.inputTokens;
      total.outputTokens += cost.outputTokens;
    }
  }
  return found ? total : null;
}

/** The token usage that an AI SDK error keeps (a schema failure keeps its response usage). */
export function usageFromError(error: unknown, depth = 0): Record<string, unknown> | undefined {
  const value = error as Record<string, any> | null | undefined;
  if (!value || typeof value !== 'object' || depth > 3) return undefined;
  const usage = value.usage;
  if (usage && typeof usage === 'object' && (Number(usage.inputTokens) > 0 || Number(usage.outputTokens) > 0))
    return usage;
  return usageFromError(value.lastError, depth + 1) ?? usageFromError(value.cause, depth + 1);
}

/** The generation id that an AI SDK error keeps in its response metadata. */
function generationIdFromError(error: unknown): string | undefined {
  const id = (error as { response?: { id?: unknown } } | null)?.response?.id;
  return typeof id === 'string' && id.startsWith('gen-') ? id : undefined;
}

type RecordFn<R> = (
  runtime: R,
  feature: string,
  usage: any,
  ok: boolean,
  error?: string,
) => Promise<unknown> | unknown;

export interface FailedModelCall<R extends { provider: string; source: string }> {
  runtime: R;
  feature: string;
  error: unknown;
  /** Generation ids that the call's requests got. */
  generationIds?: readonly string[];
  /** Usage that the caller already has for the failed call, such as the steps that finished. */
  usage?: Record<string, unknown>;
  /** The error text to record. Default: the error message. */
  message?: string;
  record: RecordFn<R>;
  /** The key for the cost lookup. Only hosted OpenRouter calls look up a cost. */
  apiKey?: string;
  lookup?: (ids: readonly string[], options: LookupOptions) => Promise<GenerationCost | null>;
  /** Runs the lookup after the caller continues. Tests await it. */
  schedule?: (task: () => Promise<void>) => void;
}

function errorText(error: unknown) {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : undefined;
}

/**
 * Records one failed or stopped model call with `ok: false`, its error, and
 * the usage it had. A hosted OpenRouter call with a generation id records the
 * real cost after the lookup; the caller does not wait for it.
 */
export async function recordFailedModelCall<R extends { provider: string; source: string }>(
  call: FailedModelCall<R>,
): Promise<void> {
  const usage = call.usage ?? usageFromError(call.error);
  const message = call.message ?? errorText(call.error);
  const ids = [...new Set([...(call.generationIds ?? []), generationIdFromError(call.error)])].filter(
    (id): id is string => Boolean(id),
  );
  const apiKey = call.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!ids.length || !apiKey || call.runtime.provider !== 'openrouter' || call.runtime.source !== 'lab86') {
    await call.record(call.runtime, call.feature, usage, false, message);
    return;
  }
  const lookup = call.lookup ?? lookupGenerationCosts;
  const schedule =
    call.schedule ??
    ((task: () => Promise<void>) => {
      void task().catch(() => undefined);
    });
  schedule(async () => {
    const cost = await lookup(ids, { apiKey }).catch(() => null);
    // The lookup covers every request of the call, so its tokens win.
    const recorded = cost
      ? {
          ...usage,
          inputTokens: cost.inputTokens || Number(usage?.inputTokens) || 0,
          outputTokens: cost.outputTokens || Number(usage?.outputTokens) || 0,
          totalTokens: undefined,
          costUsd: cost.costUsd,
        }
      : usage;
    await call.record(call.runtime, call.feature, recorded, false, message);
  });
}
