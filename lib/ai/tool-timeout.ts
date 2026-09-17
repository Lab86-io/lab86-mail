const DEFAULT_TIMEOUT_MS = 75_000;
const GENERATION_TIMEOUT_MS = 210_000;

export function agentToolTimeoutMs(name: string, args: Record<string, unknown> = {}) {
  if (
    name === 'presentation_plan' ||
    name === 'albatross_replan_work' ||
    name === 'document_suggest_changes' ||
    name === 'document_apply_instruction' ||
    (name === 'document_create' && (args.instructions || args.presentation))
  )
    return GENERATION_TIMEOUT_MS;
  return DEFAULT_TIMEOUT_MS;
}

/** Cancel cooperative work before reporting a timeout; callers must check before committing. */
export async function withToolTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  toolName: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  signal.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? agentToolTimeoutMs(toolName);
  const timer = setTimeout(() => {
    controller.abort(new Error(`${toolName} timed out after ${Math.round(timeoutMs / 1000)}s`));
  }, timeoutMs);
  let onAbort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([run(signal), cancelled]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}
