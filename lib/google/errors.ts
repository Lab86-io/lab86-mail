// Direct Google transport: the error type. It carries `statusCode`, the field
// that `nylasErrorStatus()` and the grant-health code already read, so callers
// treat a Google error like a Nylas error.

export class GoogleApiError extends Error {
  readonly statusCode: number;
  readonly reason?: string;
  readonly providerError = true;

  constructor(statusCode: number, message: string, reason?: string) {
    super(message);
    this.name = 'GoogleApiError';
    this.statusCode = statusCode;
    this.reason = reason;
  }
}
