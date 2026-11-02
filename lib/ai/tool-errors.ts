// Why a tool call failed, in words that are safe to keep. A checkpoint row
// stores the class and the code below and never the error message, because a
// message can hold personal data. A typed error also says whether the same
// arguments may run again (lib/ai/execution.ts).

export type ToolErrorClass = 'timeout' | 'provider' | 'schema' | 'aborted' | 'other';

interface ToolErrorOptions {
  cause?: unknown;
  /** A short code of the tool's own, for example `office_convert`. Never free text. */
  code?: string;
  errorClass?: ToolErrorClass;
}

/** The failure leaves nothing that a second run would repeat, so the same arguments can run again. */
export class ToolRetrySafe extends Error {
  code?: string;
  errorClass?: ToolErrorClass;

  constructor(message: string, options: ToolErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code;
    this.errorClass = options.errorClass;
  }
}

/** The failure came before the handler wrote anything. */
export class ToolFailedBeforeWrite extends ToolRetrySafe {}

/** The agent tool limit ended this call. The handler can still be at work behind it. */
export class ToolTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolTimeoutError';
  }
}

/**
 * The text the model reads when a call passes its limit. A write can finish
 * after the limit, so the text for a write says that it may have saved.
 */
export function toolTimeoutMessage(toolName: string, timeoutMs: number, mutating = false) {
  const seconds = Math.round(timeoutMs / 1000);
  return mutating
    ? `${toolName} did not answer in ${seconds}s. It may have saved: read the source first, and do not repeat the call until you know.`
    : `${toolName} timed out after ${seconds}s.`;
}

function errorChain(error: unknown): any[] {
  const chain: any[] = [];
  let current: any = error;
  while (current && typeof current === 'object' && chain.length < 5 && !chain.includes(current)) {
    chain.push(current);
    current = current.cause ?? current.lastError;
  }
  return chain;
}

/** True when the error, or an error that caused it, proves that the same arguments can run again. */
export function isToolRetrySafe(error: unknown): boolean {
  return errorChain(error).some((entry) => entry instanceof ToolRetrySafe);
}

/** Stop before a commit when the call already ended. Nothing was written, so a retry can claim it. */
export function stopIfAborted(signal: AbortSignal | undefined) {
  if (!signal?.aborted) return;
  const timedOut = signal.reason instanceof ToolTimeoutError;
  throw new ToolFailedBeforeWrite(
    timedOut ? signal.reason.message : 'The call stopped before it wrote anything.',
    { cause: signal.reason, errorClass: timedOut ? 'timeout' : 'aborted' },
  );
}

/**
 * Runs a step that only reads. A failure of the step keeps its own type, for
 * callers that read it, and also proves that the tool wrote nothing yet.
 */
export async function beforeWrite<T>(read: () => Promise<T>, code?: string): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof Error && !isToolRetrySafe(error)) {
      error.cause = new ToolFailedBeforeWrite(error.message, { cause: error.cause, code });
    }
    throw error;
  }
}

const CODE_SHAPE = /^[A-Za-z0-9_.:-]{1,64}$/;

function toolErrorCode(chain: any[]): string | undefined {
  for (const entry of chain) {
    const code = entry.code ?? entry.errorCode;
    if (typeof code === 'string' && CODE_SHAPE.test(code)) return code;
  }
  for (const entry of chain) {
    const status = entry.statusCode ?? entry.status;
    if (Number.isInteger(status) && status > 0) return `http_${status}`;
  }
  return undefined;
}

const SCHEMA_ERROR_NAMES = new Set([
  'ToolValidationError',
  'ZodError',
  'AI_NoObjectGeneratedError',
  'AI_TypeValidationError',
  'AI_JSONParseError',
  'AI_InvalidToolInputError',
]);

/**
 * The class and the code to store for a failed call. A failure that follows
 * an abort counts as the abort, because the handler sees only the side effect
 * of it. The message of the error is never read for storage.
 */
export function classifyToolError(
  error: unknown,
  signal?: AbortSignal,
): { errorClass: ToolErrorClass; errorCode?: string } {
  const chain = errorChain(error);
  const errorCode = toolErrorCode(chain);
  const withCode = (errorClass: ToolErrorClass) => ({ errorClass, ...(errorCode ? { errorCode } : {}) });
  const names = chain.map((entry) => String(entry.name ?? ''));
  if (
    signal?.reason instanceof ToolTimeoutError ||
    names.includes('ToolTimeoutError') ||
    names.includes('TimeoutError') ||
    chain.some((entry) => /\btimed out\b/i.test(String(entry.message ?? '')))
  )
    return withCode('timeout');
  if (signal?.aborted || names.includes('AbortError')) return withCode('aborted');
  const declared = chain.find((entry) => entry.errorClass)?.errorClass as ToolErrorClass | undefined;
  if (declared) return withCode(declared);
  if (names.some((name) => SCHEMA_ERROR_NAMES.has(name))) return withCode('schema');
  if (
    names.some((name) => name.startsWith('AI_') || name.startsWith('Nylas')) ||
    chain.some(
      (entry) =>
        Number.isInteger(entry.statusCode ?? entry.status) ||
        entry.responseBody !== undefined ||
        entry.provider,
    )
  )
    return withCode('provider');
  return withCode('other');
}
