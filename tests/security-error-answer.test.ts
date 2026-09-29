import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { APICallError } from 'ai';
import { AuthRequiredError } from '../lib/auth/current-user';
import { errorAnswerMessage, GENERIC_SERVER_ERROR, serverErrorMessage } from '../lib/security/error-answer';

const PRIVATE = 'Nylas 500: grant 7f3c for jakob@example.test, subject "Merger closes Friday"';

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()?.();
});

function captureConsoleError() {
  const spy = spyOn(console, 'error').mockImplementation(() => undefined);
  restores.push(() => spy.mockRestore());
  return spy;
}

describe('error answers', () => {
  test('a 5xx answer gets the fallback and the log gets a summary', () => {
    const logged = captureConsoleError();
    const error = new Error(PRIVATE);

    expect(errorAnswerMessage(500, error, 'tool failure', '[tools/x] failed')).toBe('tool failure');
    expect(errorAnswerMessage(502, error)).toBe(GENERIC_SERVER_ERROR);
    expect(logged).toHaveBeenCalledTimes(2);
    expect(logged.mock.calls[0][0]).toBe('[tools/x] failed');
    expect(logged.mock.calls[0][1]).toMatchObject({ name: 'Error' });
    expect(logged.mock.calls[1][0]).toBe('[api] request failed');
  });

  test('a 5xx answer from a model error never holds the prompt, in the answer or the log', () => {
    const logged = captureConsoleError();
    const error = new APICallError({
      message: 'Bad Request',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      requestBodyValues: { messages: [{ role: 'user', content: PRIVATE }] },
      statusCode: 400,
      responseBody: PRIVATE,
    });

    const answer = serverErrorMessage('[albatross-plan-route]', error, 'plan generation failed');
    expect(answer).toBe('plan generation failed');
    const printed = Bun.inspect(logged.mock.calls);
    expect(printed).toContain('AI_APICallError');
    expect(printed).not.toContain('Merger');
    expect(printed).not.toContain('jakob@example.test');
  });

  test('a 4xx answer keeps the message that the app wrote', () => {
    const logged = captureConsoleError();
    expect(errorAnswerMessage(401, new AuthRequiredError('Sign in first.'), 'prefs failed')).toBe(
      'Sign in first.',
    );
    expect(errorAnswerMessage(400, new Error('Pick a date first.'), 'failed')).toBe('Pick a date first.');
    expect(logged).not.toHaveBeenCalled();
  });

  test('a 4xx answer without a message gets the fallback', () => {
    expect(errorAnswerMessage(404, new Error(''), 'not found')).toBe('not found');
    expect(errorAnswerMessage(409, { message: PRIVATE }, 'conflict')).toBe('conflict');
    expect(errorAnswerMessage(400, PRIVATE)).toBe(GENERIC_SERVER_ERROR);
  });
});
