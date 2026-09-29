import { describe, expect, spyOn, test } from 'bun:test';
import { APICallError, JSONParseError, NoObjectGeneratedError, RetryError, TypeValidationError } from 'ai';
import { describeModelError, MODEL_ERROR_MESSAGE_LIMIT, redactModelErrorMessage } from '../lib/ai/log-error';

const MAIL = 'Dear Jakob, the merger closes Friday. Wire code 4471.';

function apiCallError() {
  return new APICallError({
    message: 'Bad Request',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    requestBodyValues: { model: 'm', messages: [{ role: 'user', content: MAIL }] },
    statusCode: 400,
    responseHeaders: { authorization: 'Bearer sk-or-v1-abcdefghijklmnop' },
    responseBody: `{"error":{"message":"bad","echo":${JSON.stringify(MAIL)}}}`,
    cause: new TypeError('fetch failed'),
  });
}

describe('describeModelError', () => {
  test('an APICallError never leaks the prompt or the response body', () => {
    const summary = describeModelError(apiCallError());
    const logged = JSON.stringify(summary);

    expect(summary).toEqual({
      name: 'AI_APICallError',
      statusCode: 400,
      message: 'Bad Request',
      cause: 'TypeError',
    });
    expect(logged).not.toContain('merger');
    expect(logged).not.toContain('Wire code');
    expect(logged).not.toContain('openrouter.ai');
    expect(logged).not.toContain('sk-or-v1');
  });

  test('the console line holds only the summary', () => {
    const spy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      console.error('[brief] model call failed:', describeModelError(apiCallError()));
      const printed = Bun.inspect(spy.mock.calls);
      expect(printed).toContain('AI_APICallError');
      expect(printed).not.toContain('merger');
      expect(printed).not.toContain('requestBodyValues');
    } finally {
      spy.mockRestore();
    }
  });

  test('a RetryError does not leak the errors that it holds', () => {
    const error = new RetryError({
      message: 'Failed after 3 attempts. Last error: Bad Request',
      reason: 'maxRetriesExceeded',
      errors: [apiCallError(), apiCallError()],
    });
    const summary = describeModelError(error);

    expect(summary.name).toBe('AI_RetryError');
    expect(summary.message).toBe('Failed after 3 attempts. Last error: Bad Request');
    expect(JSON.stringify(summary)).not.toContain('merger');
  });

  test('model output in JSON parse and type validation messages is removed', () => {
    const parse = describeModelError(
      new JSONParseError({ text: `{"summary":"${MAIL}"`, cause: new SyntaxError('Unexpected end') }),
    );
    expect(parse.name).toBe('AI_JSONParseError');
    expect(parse.message).toBe('JSON parsing failed: Text: [redacted]. Error message: Unexpected end');
    expect(parse.cause).toBe('SyntaxError');

    const invalid = describeModelError(
      new TypeValidationError({
        value: { summary: `${MAIL}. Error message: fake` },
        cause: new Error('Expected string'),
      }),
    );
    expect(invalid.message).toBe('Type validation failed: Value: [redacted]. Error message: Expected string');
    expect(JSON.stringify(invalid)).not.toContain('merger');
  });

  test('a NoObjectGeneratedError keeps its text out of the summary', () => {
    const error = new NoObjectGeneratedError({
      message: 'No object generated: response did not match schema.',
      text: MAIL,
      response: { id: 'r', timestamp: new Date(0), modelId: 'm' },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as any,
      finishReason: 'stop',
    });
    expect(JSON.stringify(describeModelError(error))).not.toContain('merger');
  });

  test('a long message is cut, and white space is folded', () => {
    const summary = describeModelError(new Error(`line one\n\n${'x'.repeat(1000)}`));
    expect(summary.message.length).toBe(MODEL_ERROR_MESSAGE_LIMIT);
    expect(summary.message.startsWith('line one x')).toBe(true);
    expect(summary.message.endsWith('…')).toBe(true);
  });

  test('credentials in a message are removed', () => {
    expect(redactModelErrorMessage('401 for Bearer abc.def-123 with key sk-ant-abcdefghijk')).toBe(
      '401 for Bearer [redacted] with key [redacted key]',
    );
    expect(redactModelErrorMessage('schema failed near Value: {"a":1}')).toBe(
      'schema failed near Value: [redacted]',
    );
  });

  test('other values give a summary without their fields', () => {
    expect(describeModelError('model timed out')).toEqual({ name: 'Error', message: 'model timed out' });
    expect(describeModelError(null)).toEqual({ name: 'unknown', message: '' });
    expect(describeModelError(undefined)).toEqual({ name: 'unknown', message: '' });
    expect(describeModelError(42)).toEqual({ name: 'Error', message: '' });
    expect(
      describeModelError({ message: 'upstream failed', status: 503, prompt: MAIL, cause: 'not an error' }),
    ).toEqual({ name: 'Error', statusCode: 503, message: 'upstream failed' });
    expect(describeModelError({ name: 'AbortError', message: 'aborted', statusCode: Number.NaN })).toEqual({
      name: 'AbortError',
      message: 'aborted',
    });
  });
});
