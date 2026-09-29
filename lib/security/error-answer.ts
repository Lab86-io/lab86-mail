// Error answers of the API routes (CASA finding S7).
//
// The message of an unknown or provider error can hold provider detail,
// internal names, or text from mail and model output. A 5xx answer never
// passes that message to the client: it gets a fixed text, and the server log
// gets a short summary (describeModelError never logs the request or the
// response body of a model call). A 4xx answer is for an error that the app
// itself found (a typed error with a message that the app wrote), so it keeps
// that message.

import { describeModelError } from '@/lib/ai/log-error';

export const GENERIC_SERVER_ERROR = 'The server could not complete the request.';

/** Logs a summary of `error` under `label` and returns `fallback` for the answer. */
export function serverErrorMessage(
  label: string,
  error: unknown,
  fallback: string = GENERIC_SERVER_ERROR,
): string {
  console.error(label, describeModelError(error));
  return fallback;
}

/**
 * The message of an error answer with `status`. A status below 500 keeps the
 * app-written message of the error. A 5xx status gets `fallback`, and the
 * error goes to the server log.
 */
export function errorAnswerMessage(
  status: number,
  error: unknown,
  fallback: string = GENERIC_SERVER_ERROR,
  label = '[api] request failed',
): string {
  if (status >= 500) return serverErrorMessage(label, error, fallback);
  const message = error instanceof Error ? error.message : '';
  return message || fallback;
}
