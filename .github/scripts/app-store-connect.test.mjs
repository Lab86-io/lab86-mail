import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AppStoreConnectRequestError,
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

test('parses bounded numeric and HTTP-date Retry-After values', () => {
  assert.equal(retryAfterMilliseconds('1'), 1_000);
  assert.equal(retryAfterMilliseconds('999'), 30_000);
  assert.equal(retryAfterMilliseconds('Thu, 01 Jan 1970 00:00:12 GMT', 10_000), 2_000);
  assert.equal(retryAfterMilliseconds('invalid'), null);
});
