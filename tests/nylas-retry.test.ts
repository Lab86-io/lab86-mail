import { describe, expect, test } from 'bun:test';
import {
  describeNylasError,
  isNylasResponseParseError,
  nylasErrorStatus,
  withNylasRetry,
} from '../lib/nylas/retry';

describe('nylasErrorStatus', () => {
  test('reads status from common error shapes', () => {
    expect(nylasErrorStatus({ statusCode: 502 })).toBe(502);
    expect(nylasErrorStatus({ status: 429 })).toBe(429);
    expect(nylasErrorStatus({ response: { status: 503 } })).toBe(503);
    expect(nylasErrorStatus(new Error('x'))).toBeUndefined();
  });
});

describe('isNylasResponseParseError', () => {
  test('detects malformed provider bodies', () => {
    expect(isNylasResponseParseError(new Error('Could not parse response from the server'))).toBe(true);
    expect(isNylasResponseParseError(new Error('invalid json response body'))).toBe(true);
    expect(isNylasResponseParseError(new Error('HTTP 502'))).toBe(false);
  });
});

describe('describeNylasError', () => {
  test('includes status and trace ids when present', () => {
    const err = Object.assign(new Error('Server Error'), {
      statusCode: 500,
      requestId: 'req_1',
      flowId: 'flow_1',
    });
    expect(describeNylasError(err)).toBe('HTTP 500: Server Error (request req_1, flow flow_1)');
  });
  test('preserves primitive thrown values', () => {
    expect(describeNylasError('provider unavailable')).toBe('provider unavailable');
  });
});

describe('withNylasRetry', () => {
  test('retries transient 5xx failures then succeeds', async () => {
    let attempts = 0;
    const result = await withNylasRetry(async () => {
      attempts += 1;
      if (attempts < 2) {
        throw Object.assign(new Error('Server Error'), { statusCode: 503 });
      }
      return 'ok';
    }, 2);
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });
  test('does not retry client errors', async () => {
    let attempts = 0;
    await expect(
      withNylasRetry(async () => {
        attempts += 1;
        throw Object.assign(new Error('Not found'), { statusCode: 404 });
      }, 2),
    ).rejects.toThrow('Not found');
    expect(attempts).toBe(1);
  });
});
