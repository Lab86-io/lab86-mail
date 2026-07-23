import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { AuthRequiredError } from '@/lib/auth/current-user';
import { RateLimitError } from '@/lib/rate-limit';
import { ToolValidationError } from '@/lib/tools/registry';

export interface MobileHTTPError {
  code: string;
  message: string;
  retryable: boolean;
  status: number;
}

export class MobileInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MobileInputError';
  }
}

export class MobileConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MobileConflictError';
  }
}

export class MobileNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MobileNotFoundError';
  }
}

export class MobileIdempotencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MobileIdempotencyConflictError';
  }
}

export function mobileRequestID(request: Request): string {
  const incoming = request.headers.get('x-request-id')?.trim();
  return incoming && incoming.length <= 240 ? incoming : randomUUID();
}

export function mobileJSON(body: unknown, init: ResponseInit = {}, requestID?: string): Response {
  const headers = new Headers(init.headers);
  if (requestID) headers.set('x-request-id', requestID);
  return Response.json(body, { ...init, headers });
}

export function mapMobileHTTPError(error: unknown): MobileHTTPError {
  if (error instanceof AuthRequiredError) {
    return { code: 'AUTH_REQUIRED', message: error.message, retryable: false, status: 401 };
  }
  if (
    error instanceof ZodError ||
    error instanceof ToolValidationError ||
    error instanceof MobileInputError ||
    error instanceof SyntaxError
  ) {
    return {
      code: 'INVALID_REQUEST',
      message: error instanceof Error ? error.message : 'The request is invalid.',
      retryable: false,
      status: 400,
    };
  }
  if (error instanceof MobileConflictError) {
    return { code: 'CONFLICT', message: error.message, retryable: false, status: 409 };
  }
  if (error instanceof MobileNotFoundError) {
    return { code: 'NOT_FOUND', message: error.message, retryable: false, status: 404 };
  }
  if (error instanceof MobileIdempotencyConflictError) {
    return {
      code: 'IDEMPOTENCY_KEY_REUSED',
      message: error.message,
      retryable: false,
      status: 409,
    };
  }
  if (error instanceof RateLimitError) {
    return { code: 'RATE_LIMITED', message: error.message, retryable: true, status: 429 };
  }
  return {
    code: 'SERVER_ERROR',
    message: 'The server could not complete the request.',
    retryable: true,
    status: 500,
  };
}

export function mobileErrorResponse(error: unknown, requestID: string): Response {
  const mapped = mapMobileHTTPError(error);
  if (mapped.status >= 500) console.error('Mobile API request failed.', error);
  return mobileJSON(
    {
      ok: false,
      requestID,
      error: { code: mapped.code, message: mapped.message, retryable: mapped.retryable },
    },
    { status: mapped.status },
    requestID,
  );
}
