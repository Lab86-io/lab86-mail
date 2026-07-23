import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { AuthRequiredError } from '@/lib/auth/current-user';
import {
  MobileConflictError,
  MobileIdempotencyConflictError,
  MobileInputError,
  MobileNotFoundError,
  mapMobileHTTPError,
  mobileErrorResponse,
  mobileJSON,
  mobileRequestID,
} from '@/lib/mobile/v1/http';
import { RateLimitError } from '@/lib/rate-limit';
import { ToolValidationError } from '@/lib/tools/registry';

describe('mobile HTTP contract', () => {
  test('preserves a bounded caller request ID and replaces invalid IDs', () => {
    const preserved = mobileRequestID(
      new Request('https://mail.test/api/mobile/v1/bootstrap', {
        headers: { 'x-request-id': '  ios-request-42  ' },
      }),
    );
    const generatedForMissing = mobileRequestID(new Request('https://mail.test/api/mobile/v1/bootstrap'));
    const generatedForOversized = mobileRequestID(
      new Request('https://mail.test/api/mobile/v1/bootstrap', {
        headers: { 'x-request-id': 'x'.repeat(241) },
      }),
    );

    expect(preserved).toBe('ios-request-42');
    expect(generatedForMissing).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(generatedForOversized).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(generatedForOversized).not.toBe(generatedForMissing);
  });

  test('serializes JSON while preserving response options and request identity', async () => {
    const response = mobileJSON(
      { ok: true },
      { status: 202, headers: { 'cache-control': 'no-store' } },
      'request-202',
    );
    const responseWithoutRequestID = mobileJSON({ ok: true });

    expect(response.status).toBe(202);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('x-request-id')).toBe('request-202');
    expect(await response.json()).toEqual({ ok: true });
    expect(responseWithoutRequestID.headers.has('x-request-id')).toBe(false);
  });

  test('maps authentication, validation, conflict, rate-limit, and server failures', () => {
    let zodError: unknown;
    try {
      z.string().parse(42);
    } catch (error) {
      zodError = error;
    }

    expect(mapMobileHTTPError(new AuthRequiredError('Sign in required.'))).toEqual({
      code: 'AUTH_REQUIRED',
      message: 'Sign in required.',
      retryable: false,
      status: 401,
    });

    for (const error of [
      zodError,
      new ToolValidationError('Unknown command.'),
      new MobileInputError('Missing cursor.'),
      new SyntaxError('Malformed JSON.'),
    ]) {
      expect(mapMobileHTTPError(error)).toMatchObject({
        code: 'INVALID_REQUEST',
        retryable: false,
        status: 400,
      });
    }

    expect(mapMobileHTTPError(new MobileConflictError('Already undone.'))).toEqual({
      code: 'CONFLICT',
      message: 'Already undone.',
      retryable: false,
      status: 409,
    });
    expect(mapMobileHTTPError(new MobileNotFoundError('Missing.'))).toEqual({
      code: 'NOT_FOUND',
      message: 'Missing.',
      retryable: false,
      status: 404,
    });
    expect(mapMobileHTTPError(new MobileIdempotencyConflictError('Key reused.'))).toEqual({
      code: 'IDEMPOTENCY_KEY_REUSED',
      message: 'Key reused.',
      retryable: false,
      status: 409,
    });
    expect(mapMobileHTTPError(new RateLimitError('Slow down.', 1_000, 10))).toEqual({
      code: 'RATE_LIMITED',
      message: 'Slow down.',
      retryable: true,
      status: 429,
    });
    expect(mapMobileHTTPError(new Error('Database unavailable.'))).toEqual({
      code: 'SERVER_ERROR',
      message: 'The server could not complete the request.',
      retryable: true,
      status: 500,
    });
    expect(mapMobileHTTPError(null)).toEqual({
      code: 'SERVER_ERROR',
      message: 'The server could not complete the request.',
      retryable: true,
      status: 500,
    });
  });

  test('returns the stable native error envelope and response identity', async () => {
    const response = mobileErrorResponse(new MobileInputError('Cursor is invalid.'), 'request-400');

    expect(response.status).toBe(400);
    expect(response.headers.get('x-request-id')).toBe('request-400');
    expect(await response.json()).toEqual({
      ok: false,
      requestID: 'request-400',
      error: {
        code: 'INVALID_REQUEST',
        message: 'Cursor is invalid.',
        retryable: false,
      },
    });
  });
});
