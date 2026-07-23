const DEFAULT_TIMEOUT_MILLISECONDS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_RETRY_DELAY_MILLISECONDS = 1_000;
const MAX_RETRY_DELAY_MILLISECONDS = 30_000;

export class AppStoreConnectRequestError extends Error {
  constructor(message, { recoverable = false, status, cause } = {}) {
    super(message, { cause });
    this.name = 'AppStoreConnectRequestError';
    this.recoverable = recoverable;
    this.status = status;
  }
}

export function retryAfterMilliseconds(value, now = Date.now()) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, MAX_RETRY_DELAY_MILLISECONDS);
  }
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.min(Math.max(0, date - now), MAX_RETRY_DELAY_MILLISECONDS);
}

function isTransientStatus(status) {
  return status === 429 || status >= 500;
}

function requestSignal(callerSignal, timeoutMilliseconds) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('App Store Connect request timed out.')),
    timeoutMilliseconds,
  );
  const abortFromCaller = () => controller.abort(callerSignal.reason);
  callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      callerSignal?.removeEventListener('abort', abortFromCaller);
    },
  };
}

export async function requestAppStoreConnect(
  path,
  {
    getToken,
    options = {},
    fetchImpl = fetch,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    timeoutMilliseconds = DEFAULT_TIMEOUT_MILLISECONDS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    retryDelayMilliseconds = DEFAULT_RETRY_DELAY_MILLISECONDS,
  } = {},
) {
  if (typeof getToken !== 'function') {
    throw new Error('requestAppStoreConnect requires a token provider.');
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error('App Store Connect request was cancelled.');
    }
    const token = getToken();
    const { signal, dispose } = requestSignal(options.signal, timeoutMilliseconds);
    let response;
    try {
      response = await fetchImpl(`https://api.appstoreconnect.apple.com${path}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...options.headers,
        },
        signal,
      });
    } catch (error) {
      dispose();
      if (attempt < maxAttempts) {
        await sleep(Math.min(retryDelayMilliseconds * 2 ** (attempt - 1), MAX_RETRY_DELAY_MILLISECONDS));
        continue;
      }
      throw new AppStoreConnectRequestError(
        `App Store Connect request failed: ${error instanceof Error ? error.message : String(error)}`,
        { recoverable: true, cause: error },
      );
    }

    let text;
    try {
      text = await response.text();
    } catch (error) {
      dispose();
      if (attempt < maxAttempts) {
        await sleep(Math.min(retryDelayMilliseconds * 2 ** (attempt - 1), MAX_RETRY_DELAY_MILLISECONDS));
        continue;
      }
      throw new AppStoreConnectRequestError('App Store Connect response body could not be read.', {
        recoverable: true,
        status: response.status,
        cause: error,
      });
    }
    dispose();

    let body = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch (error) {
        if (response.ok) {
          throw new AppStoreConnectRequestError('App Store Connect returned invalid JSON.', {
            status: response.status,
            cause: error,
          });
        }
        body = { raw: text };
      }
    }

    if (response.ok) return body;

    const recoverable = isTransientStatus(response.status);
    if (recoverable && attempt < maxAttempts) {
      const retryAfter = retryAfterMilliseconds(response.headers?.get?.('retry-after'));
      await sleep(
        retryAfter ?? Math.min(retryDelayMilliseconds * 2 ** (attempt - 1), MAX_RETRY_DELAY_MILLISECONDS),
      );
      continue;
    }

    throw new AppStoreConnectRequestError(
      `App Store Connect request failed (${response.status}): ${JSON.stringify(body)}`,
      { recoverable, status: response.status },
    );
  }

  throw new AppStoreConnectRequestError('App Store Connect request exhausted its retry budget.', {
    recoverable: true,
  });
}
