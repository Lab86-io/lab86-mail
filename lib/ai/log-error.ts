// Log-safe summaries of model and AI SDK errors (CASA finding S8).
//
// An AI SDK APICallError holds the full request body (requestBodyValues: the
// prompt, with mail text) and the provider answer (responseBody). A
// RetryError holds each failed APICallError. JSONParseError and
// TypeValidationError put the model output into their message, and
// NoObjectGeneratedError keeps it in `text`. A raw error object in
// console.error prints all of this to the server log. Log the summary
// from describeModelError instead: the name, the HTTP status, a short message
// without model text, and the name of the cause.

export const MODEL_ERROR_MESSAGE_LIMIT = 300;

export interface ModelErrorSummary {
  name: string;
  statusCode?: number;
  message: string;
  cause?: string;
}

// "JSON parsing failed: Text: <model output>.\nError message: ..." and
// "Type validation failed: Value: <model output>.\nError message: ...". The
// match is greedy: model output can hold the words "Error message:" too.
const EMBEDDED_VALUE = /\b(Text|Value): [\s\S]*\.\s*(?=Error message:)/;
const TRAILING_VALUE = /\b(Text|Value): [\s\S]*$/;
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const API_KEY = /\bsk-(?:or-v1-|ant-|proj-)?[A-Za-z0-9_-]{8,}\b/g;

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : undefined;
}

function statusField(value: unknown): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const candidate of [record.statusCode, record.status]) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
  }
  return undefined;
}

/** Remove model output, credentials, and length from an error message. */
export function redactModelErrorMessage(message: string): string {
  let text = message.replace(EMBEDDED_VALUE, '$1: [redacted]. ');
  if (!/\b(?:Text|Value): \[redacted\]/.test(text)) text = text.replace(TRAILING_VALUE, '$1: [redacted]');
  text = text.replace(BEARER, '$1[redacted]').replace(API_KEY, '[redacted key]');
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > MODEL_ERROR_MESSAGE_LIMIT ? `${text.slice(0, MODEL_ERROR_MESSAGE_LIMIT - 1)}…` : text;
}

/**
 * A summary of an error that is safe for the server log. It never holds the
 * request body, the response body, or other fields of the error object.
 */
export function describeModelError(error: unknown): ModelErrorSummary {
  if (typeof error === 'string') return { name: 'Error', message: redactModelErrorMessage(error) };
  const name = stringField(error, 'name') || (error === null || error === undefined ? 'unknown' : 'Error');
  const summary: ModelErrorSummary = {
    name,
    message: redactModelErrorMessage(stringField(error, 'message') ?? ''),
  };
  const statusCode = statusField(error);
  if (statusCode !== undefined) summary.statusCode = statusCode;
  const cause = error && typeof error === 'object' ? (error as { cause?: unknown }).cause : undefined;
  const causeName = stringField(cause, 'name');
  if (causeName) summary.cause = causeName;
  return summary;
}
