import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import test from 'node:test';
import {
  AppStoreConnectRequestError,
  createAppStoreConnectToken,
  requestAppStoreConnect,
  retryAfterMilliseconds,
} from './app-store-connect.mjs';

function response(status, body, retryAfter) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name === 'retry-after' ? retryAfter : null) },
    async text() {
      return JSON.stringify(body);
    },
  };
}

test('creates a normalized, short-lived ES256 App Store Connect token', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const privatePEM = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const token = createAppStoreConnectToken({
    issuerID: 'issuer-123',
    keyID: 'key-456',
    privateKey: privatePEM.replaceAll('\n', '\\n'),
    nowSeconds: 10_000,
  });
  const [encodedHeader, encodedPayload, encodedSignature] = token.split('.');

  assert.deepEqual(JSON.parse(Buffer.from(encodedHeader, 'base64url').toString()), {
    alg: 'ES256',
    kid: 'key-456',
    typ: 'JWT',
  });
  assert.deepEqual(JSON.parse(Buffer.from(encodedPayload, 'base64url').toString()), {
    iss: 'issuer-123',
    iat: 9_990,
    exp: 10_600,
    aud: 'appstoreconnect-v1',
  });
  assert.equal(
    verify(
      'sha256',
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(encodedSignature, 'base64url'),
    ),
    true,
  );
});

test('retries transient responses and honors Retry-After', async () => {
  const delays = [];
  let calls = 0;
  const result = await requestAppStoreConnect('/v1/builds', {
    getToken: () => 'token',
    fetchImpl: async (_url, options) => {
      assert.ok(options.signal);
      calls += 1;
      return calls === 1 ? response(503, { error: 'busy' }, '2') : response(200, { data: [] });
    },
    sleep: async (milliseconds) => delays.push(milliseconds),
  });

  assert.deepEqual(result, { data: [] });
  assert.equal(calls, 2);
  assert.deepEqual(delays, [2_000]);
});

test('retries a transient non-JSON response body', async () => {
  let calls = 0;
  const result = await requestAppStoreConnect('/v1/builds', {
    getToken: () => 'token',
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          status: 503,
          headers: { get: () => null },
          async text() {
            return 'temporarily unavailable';
          },
        };
      }
      return response(200, { data: [] });
    },
    sleep: async () => {},
  });

  assert.deepEqual(result, { data: [] });
  assert.equal(calls, 2);
});

test('keeps authentication failures fatal', async () => {
  await assert.rejects(
    requestAppStoreConnect('/v1/builds', {
      getToken: () => 'token',
      fetchImpl: async () => response(401, { error: 'unauthorized' }),
      sleep: async () => assert.fail('fatal responses must not retry'),
    }),
    (error) =>
      error instanceof AppStoreConnectRequestError && error.status === 401 && error.recoverable === false,
  );
});

test('marks exhausted network failures recoverable for an outer polling deadline', async () => {
  let calls = 0;
  await assert.rejects(
    requestAppStoreConnect('/v1/builds', {
      getToken: () => 'token',
      fetchImpl: async () => {
        calls += 1;
        throw new Error('offline');
      },
      sleep: async () => {},
      maxAttempts: 2,
    }),
    (error) => error instanceof AppStoreConnectRequestError && error.recoverable === true,
  );
  assert.equal(calls, 2);
});

test('propagates an already-aborted caller signal without starting a request', async () => {
  const controller = new AbortController();
  const reason = new Error('release cancelled');
  controller.abort(reason);

  await assert.rejects(
    requestAppStoreConnect('/v1/builds', {
      getToken: () => 'token',
      options: { signal: controller.signal },
      fetchImpl: async () => assert.fail('an aborted request must not call fetch'),
    }),
    (error) => error === reason,
  );
});

test('propagates caller cancellation during fetch without retrying', async () => {
  const controller = new AbortController();
  const reason = new Error('operator cancelled');
  let calls = 0;
  const pending = requestAppStoreConnect('/v1/builds', {
    getToken: () => 'token',
    options: { signal: controller.signal },
    fetchImpl: async (_url, options) => {
      calls += 1;
      return await new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    },
    sleep: async () => assert.fail('caller cancellation must not back off'),
  });

  queueMicrotask(() => controller.abort(reason));
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(calls, 1);
});

test('propagates caller cancellation while reading the response body', async () => {
  const controller = new AbortController();
  const reason = new Error('body read cancelled');
  let requestAbortSignal;
  const pending = requestAppStoreConnect('/v1/builds', {
    getToken: () => 'token',
    options: { signal: controller.signal },
    fetchImpl: async (_url, options) => {
      requestAbortSignal = options.signal;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        async text() {
          return await new Promise((_resolve, reject) => {
            requestAbortSignal.addEventListener('abort', () => reject(requestAbortSignal.reason), {
              once: true,
            });
          });
        },
      };
    },
    sleep: async () => assert.fail('caller cancellation must not back off'),
  });

  queueMicrotask(() => controller.abort(reason));
  await assert.rejects(pending, (error) => error === reason);
});

test('bounds a hung request with the configured timeout', async () => {
  let requestSignal;
  await assert.rejects(
    requestAppStoreConnect('/v1/builds', {
      getToken: () => 'token',
      fetchImpl: async (_url, options) => {
        requestSignal = options.signal;
        return await new Promise((_resolve, reject) => {
          requestSignal.addEventListener('abort', () => reject(requestSignal.reason), { once: true });
        });
      },
      timeoutMilliseconds: 1,
      maxAttempts: 1,
    }),
    (error) =>
      error instanceof AppStoreConnectRequestError &&
      error.recoverable === true &&
      error.cause?.message === 'App Store Connect request timed out.',
  );
  assert.equal(requestSignal.aborted, true);
});

test('rejects a successful response with invalid JSON', async () => {
  await assert.rejects(
    requestAppStoreConnect('/v1/builds', {
      getToken: () => 'token',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        async text() {
          return 'not-json';
        },
      }),
    }),
    (error) =>
      error instanceof AppStoreConnectRequestError &&
      error.status === 200 &&
      error.recoverable === false &&
      error.message === 'App Store Connect returned invalid JSON.',
  );
});

test('parses bounded numeric and HTTP-date Retry-After values', () => {
  assert.equal(retryAfterMilliseconds('1'), 1_000);
  assert.equal(retryAfterMilliseconds('999'), 30_000);
  assert.equal(retryAfterMilliseconds('Thu, 01 Jan 1970 00:00:12 GMT', 10_000), 2_000);
  assert.equal(retryAfterMilliseconds('invalid'), null);
});
