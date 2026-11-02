// A stalled provider must end the model call. The agent heartbeat keeps the
// connection open, and a thread reply runs on after the browser leaves, so a
// stream that sends nothing would otherwise wait until the user presses Stop.
//
// The limit sits in the provider fetch, not in the SDK `timeout.chunkMs`. The
// SDK timer also runs while a tool runs, so it would have to exceed the longest
// tool limit (380 s). This fetch sees only the model response, which has ended
// before a tool result waits, and its timer runs only while a read is open.

/** OpenRouter sends keep-alive comments far more often than this. */
export const STREAM_IDLE_TIMEOUT_MS = 120_000;

/**
 * A direct vendor stream has no documented keep-alive during reasoning, so a
 * long silence can be normal. This limit only ends a stream that is truly stuck.
 */
export const DIRECT_STREAM_IDLE_TIMEOUT_MS = 300_000;

/** A model stream that sent nothing for the limit. A 504 lets the runtime chain try the next model. */
export class ProviderStreamIdleError extends Error {
  statusCode = 504;
  isRetryable = true;

  constructor(timeoutMs: number) {
    super(`The model provider sent nothing for ${Math.round(timeoutMs / 1000)}s.`);
    this.name = 'ProviderStreamIdleError';
  }
}

function isStreamRequest(init: RequestInit | undefined) {
  return typeof init?.body === 'string' && /"stream"\s*:\s*true/.test(init.body);
}

function watchedBody(
  body: ReadableStream<Uint8Array>,
  timeoutMs: number,
  stop: (reason: unknown) => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProviderStreamIdleError(timeoutMs)), timeoutMs);
      });
      try {
        const { done, value } = await Promise.race([reader.read(), stalled]);
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        stop(error);
        void reader.cancel(error).catch(() => undefined);
        controller.error(error);
      } finally {
        clearTimeout(timer);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * A fetch for model providers. A stream request fails with
 * ProviderStreamIdleError when no headers or no bytes arrive for the limit.
 * Other requests pass through, because a generation with no stream stays silent
 * until it ends. With no `base`, it reads the global fetch at each call.
 */
export function streamIdleTimeoutFetch(
  base?: typeof fetch,
  timeoutMs = STREAM_IDLE_TIMEOUT_MS,
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const send = base ?? globalThis.fetch;
    if (!isStreamRequest(init)) return send(input, init);
    const idle = new AbortController();
    const signal = init?.signal ? AbortSignal.any([init.signal, idle.signal]) : idle.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const noHeaders = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new ProviderStreamIdleError(timeoutMs);
        idle.abort(error);
        reject(error);
      }, timeoutMs);
    });
    let response: Response;
    try {
      response = await Promise.race([send(input, { ...init, signal }), noHeaders]);
    } finally {
      clearTimeout(timer);
    }
    if (!response.body) return response;
    return new Response(
      watchedBody(response.body, timeoutMs, (reason) => idle.abort(reason)),
      { status: response.status, statusText: response.statusText, headers: response.headers },
    );
  }) as typeof fetch;
}

/** The fetch of a direct vendor: the same watch, with the longer limit. */
export function directProviderFetch(): typeof fetch {
  return streamIdleTimeoutFetch(undefined, DIRECT_STREAM_IDLE_TIMEOUT_MS);
}
