import { createPrivateKey, sign } from 'node:crypto';

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

export function createAppStoreConnectToken({
  issuerID,
  keyID,
  privateKey,
  nowSeconds = Math.floor(Date.now() / 1_000),
}) {
  const encodeJSON = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsignedToken = [
    encodeJSON({ alg: 'ES256', kid: keyID, typ: 'JWT' }),
    encodeJSON({
      iss: issuerID,
      iat: nowSeconds - 10,
      exp: nowSeconds + 600,
      aud: 'appstoreconnect-v1',
    }),
  ].join('.');
  const normalizedPrivateKey = privateKey.replaceAll('\\n', '\n').trim();
  const signature = sign('sha256', Buffer.from(unsignedToken), {
    key: createPrivateKey(`${normalizedPrivateKey}\n`),
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return `${unsignedToken}.${signature}`;
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

function backoffDelay(attempt, retryDelayMilliseconds) {
  return Math.min(retryDelayMilliseconds * 2 ** (attempt - 1), MAX_RETRY_DELAY_MILLISECONDS);
}

function throwIfCallerAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason ?? new Error('App Store Connect request was cancelled.');
  }
}

function requestSignal(callerSignal, timeoutMilliseconds) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('App Store Connect request timed out.')),
    timeoutMilliseconds,
  );
  const abortFromCaller = () => controller.abort(callerSignal.reason);
  if (callerSignal?.aborted) {
    abortFromCaller();
  } else {
    callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  }
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
    throwIfCallerAborted(options.signal);
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
      throwIfCallerAborted(options.signal);
      if (attempt < maxAttempts) {
        await sleep(backoffDelay(attempt, retryDelayMilliseconds));
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
      throwIfCallerAborted(options.signal);
      if (attempt < maxAttempts) {
        await sleep(backoffDelay(attempt, retryDelayMilliseconds));
        continue;
      }
      throw new AppStoreConnectRequestError('App Store Connect response body could not be read.', {
        recoverable: true,
        status: response.status,
        cause: error,
      });
    }
    dispose();
    throwIfCallerAborted(options.signal);

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
      await sleep(retryAfter ?? backoffDelay(attempt, retryDelayMilliseconds));
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
