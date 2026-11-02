import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  beforeWrite,
  classifyToolError,
  isToolRetrySafe,
  stopIfAborted,
  ToolFailedBeforeWrite,
  ToolRetrySafe,
  ToolTimeoutError,
  toolTimeoutMessage,
} from '../lib/ai/tool-errors';
import { withToolTimeout } from '../lib/ai/tool-timeout';

describe('the timeout text', () => {
  test('a write says that it may have saved, and a read does not', () => {
    const write = toolTimeoutMessage('calendar_create_event', 75_000, true);
    expect(write).toContain('It may have saved: read the source first');
    expect(write).not.toContain('timed out');
    expect(toolTimeoutMessage('search_threads', 75_000)).toBe('search_threads timed out after 75s.');
  });

  test('withToolTimeout rejects with the typed error and ends the signal', async () => {
    let seen: AbortSignal | undefined;
    const failed: any = await withToolTimeout(
      (signal) => {
        seen = signal;
        return new Promise(() => undefined);
      },
      'tasks_create_card',
      { timeoutMs: 5, mutating: true },
    ).catch((error) => error);
    expect(failed).toBeInstanceOf(ToolTimeoutError);
    expect(failed.message).toContain('It may have saved');
    expect(seen?.reason).toBe(failed);
  });
});

describe('a failure that proves a retry is safe', () => {
  test('the proof reads through the cause chain', () => {
    expect(isToolRetrySafe(new ToolFailedBeforeWrite('Nothing ran.'))).toBe(true);
    expect(isToolRetrySafe(new ToolRetrySafe('Recorded parts stay.'))).toBe(true);
    expect(isToolRetrySafe(new Error('wrap', { cause: new ToolFailedBeforeWrite('Nothing ran.') }))).toBe(
      true,
    );
    expect(isToolRetrySafe(new Error('Lost answer'))).toBe(false);
    expect(isToolRetrySafe(undefined)).toBe(false);
    const looped: any = new Error('Loop');
    looped.cause = looped;
    expect(isToolRetrySafe(looped)).toBe(false);
  });

  test('beforeWrite keeps the type of a read failure and adds the proof', async () => {
    class ReadFailed extends Error {}
    const failed = await beforeWrite(async () => {
      throw new ReadFailed('Board not found.');
    }, 'board_read').catch((error) => error);
    expect(failed).toBeInstanceOf(ReadFailed);
    expect(failed.message).toBe('Board not found.');
    expect(isToolRetrySafe(failed)).toBe(true);
    expect(classifyToolError(failed).errorCode).toBe('board_read');
    expect(await beforeWrite(async () => 'value')).toBe('value');
    // A thrown string stays what it was.
    expect(
      await beforeWrite(async () => {
        throw 'text';
      }).catch((error) => error),
    ).toBe('text');
  });

  test('stopIfAborted names the reason of the abort', () => {
    expect(() => stopIfAborted(undefined)).not.toThrow();
    expect(() => stopIfAborted(new AbortController().signal)).not.toThrow();
    const timedOut = (() => {
      try {
        stopIfAborted(AbortSignal.abort(new ToolTimeoutError('Too slow.')));
      } catch (error) {
        return error as ToolFailedBeforeWrite;
      }
    })();
    expect(timedOut).toBeInstanceOf(ToolFailedBeforeWrite);
    expect(timedOut?.message).toBe('Too slow.');
    expect(timedOut?.errorClass).toBe('timeout');
    const stopped = (() => {
      try {
        stopIfAborted(AbortSignal.abort());
      } catch (error) {
        return error as ToolFailedBeforeWrite;
      }
    })();
    expect(stopped?.errorClass).toBe('aborted');
  });
});

describe('the stored class and code', () => {
  test.each([
    ['a tool limit', new ToolTimeoutError('Too slow.'), { errorClass: 'timeout' }],
    ['a fetch limit', Object.assign(new Error('x'), { name: 'TimeoutError' }), { errorClass: 'timeout' }],
    ['a deadline', new Error('Deck composition timed out after 150s'), { errorClass: 'timeout' }],
    ['a stop', Object.assign(new Error('x'), { name: 'AbortError' }), { errorClass: 'aborted' }],
    ['a bad shape', new z.ZodError([]), { errorClass: 'schema' }],
    [
      'a bad model object',
      Object.assign(new Error('x'), { name: 'AI_NoObjectGeneratedError' }),
      { errorClass: 'schema' },
    ],
    [
      'a provider status',
      Object.assign(new Error('x'), { statusCode: 503 }),
      { errorClass: 'provider', errorCode: 'http_503' },
    ],
    ['a provider body', Object.assign(new Error('x'), { responseBody: '{}' }), { errorClass: 'provider' }],
    ['a mail provider', Object.assign(new Error('x'), { name: 'NylasApiError' }), { errorClass: 'provider' }],
    ['a plain error', new Error('Something broke'), { errorClass: 'other' }],
    [
      'a declared class',
      new ToolFailedBeforeWrite('x', { code: 'nylas_400', errorClass: 'provider' }),
      { errorClass: 'provider', errorCode: 'nylas_400' },
    ],
    [
      'a tool code',
      Object.assign(new Error('x'), { code: 'ECONNRESET' }),
      { errorClass: 'other', errorCode: 'ECONNRESET' },
    ],
  ] as const)('%s', (_name, error, expected) => {
    expect(classifyToolError(error) as unknown).toEqual(expected);
  });

  test('a failure after an abort counts as the abort', () => {
    const plain = new Error('Socket closed');
    expect(classifyToolError(plain, AbortSignal.abort()).errorClass).toBe('aborted');
    expect(classifyToolError(plain, AbortSignal.abort(new ToolTimeoutError('Too slow.'))).errorClass).toBe(
      'timeout',
    );
  });

  test('a code with free text never reaches the row', () => {
    const risky = Object.assign(new Error('x'), { code: 'Could not reach sam@example.test now' });
    expect(classifyToolError(risky).errorCode).toBeUndefined();
  });
});
