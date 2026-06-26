import { describe, expect, test } from 'bun:test';
import { RateLimitError, rateLimitJson, rateLimitResponse } from '../lib/rate-limit';

describe('RateLimitError', () => {
  test('stores retry metadata', () => {
    const err = new RateLimitError('Too many requests', 2500, 10);
    expect(err.name).toBe('RateLimitError');
    expect(err.retryAfterMs).toBe(2500);
    expect(err.limit).toBe(10);
    expect(err.message).toBe('Too many requests');
  });
});

describe('rateLimitJson', () => {
  test('returns a 429 JSON response with Retry-After', async () => {
    const response = rateLimitJson(new RateLimitError('Slow down', 1500, 5));
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('2');
    expect(await response.json()).toEqual({
      ok: false,
      error: 'Slow down',
      retryAfterSeconds: 2,
      limit: 5,
    });
  });
});

describe('rateLimitResponse', () => {
  test('returns a plain Response with JSON body', async () => {
    const response = rateLimitResponse(new RateLimitError('Slow down', 500, 5));
    expect(response.status).toBe(429);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toMatchObject({ ok: false, retryAfterSeconds: 1, limit: 5 });
  });
});
