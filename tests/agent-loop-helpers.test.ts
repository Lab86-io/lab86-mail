import { describe, expect, test } from 'bun:test';
import {
  errorText,
  isAuthError,
  isRecoverableAgentProviderError,
  safeAuthErrorText,
  writeDelayedAgentResult,
} from '../lib/ai/loop';

describe('errorText / safeAuthErrorText', () => {
  test('renders errors, strings, and objects', () => {
    expect(errorText(new Error('boom'))).toBe('boom');
    expect(errorText('plain')).toBe('plain');
    expect(errorText({ code: 7 })).toBe('{"code":7}');
    const circular: any = {};
    circular.self = circular;
    expect(errorText(circular)).toBe('Tool call failed');
  });

  test('redacts bearer tokens and API keys before logging', () => {
    const redacted = safeAuthErrorText(
      new Error('401 Bearer abc.def-123 rejected for sk-or-v1-abcdefgh1234'),
    );
    expect(redacted).not.toContain('abc.def-123');
    expect(redacted).not.toContain('sk-or-v1-abcdefgh1234');
    expect(redacted).toContain('[REDACTED]');
    expect(redacted).toContain('[REDACTED_API_KEY]');
  });
});

describe('provider error classification', () => {
  test('auth errors: 401 always; 403 only with a key-shaped message', () => {
    expect(isAuthError({ statusCode: 401 })).toBe(true);
    expect(isAuthError({ statusCode: 403 })).toBe(false);
    expect(isAuthError({ statusCode: 403, message: 'Invalid API key provided' })).toBe(true);
    expect(isAuthError(new Error('No auth credentials found'))).toBe(true);
    expect(isAuthError({ statusCode: 500, message: 'server exploded' })).toBe(false);
  });

  test('recoverable provider errors: 429, 5xx, malformed JSON with provider signals', () => {
    expect(isRecoverableAgentProviderError({ statusCode: 429 })).toBe(true);
    expect(isRecoverableAgentProviderError({ statusCode: 503 })).toBe(true);
    expect(
      isRecoverableAgentProviderError({
        message: 'Invalid JSON response',
        statusCode: 200,
        responseBody: '<html>',
      }),
    ).toBe(true);
    expect(isRecoverableAgentProviderError(new Error('Invalid JSON response'))).toBe(false);
    expect(isRecoverableAgentProviderError(new Error('plain logic bug'))).toBe(false);
  });
});

describe('writeDelayedAgentResult (completed-run stream replay)', () => {
  function replay(result: any) {
    const chunks: any[] = [];
    writeDelayedAgentResult({ write: (chunk: any) => chunks.push(chunk) } as any, result);
    return chunks;
  }

  test('replays text, tool calls, and tool results in stream order', () => {
    const chunks = replay({
      finishReason: 'stop',
      steps: [
        {
          stepNumber: 0,
          content: [
            { type: 'text', text: 'Searching.' },
            { type: 'tool-call', toolCallId: 'c1', toolName: 'search_threads', input: { query: 'x' } },
            { type: 'tool-result', toolCallId: 'c1', output: { threads: [] } },
          ],
        },
      ],
    });
    const types = chunks.map((chunk) => chunk.type);
    expect(types[0]).toBe('start');
    expect(types).toContain('text-start');
    expect(types).toContain('tool-input-available');
    expect(types).toContain('tool-output-available');
    expect(types[types.length - 1]).toBe('finish');
    expect(chunks[chunks.length - 1].finishReason).toBe('stop');
  });

  test('surfaces tool errors and invalid calls as error chunks', () => {
    const chunks = replay({
      steps: [
        {
          content: [
            { type: 'tool-call', toolCallId: 'c1', toolName: 'star', input: {}, invalid: true },
            { type: 'tool-call', toolCallId: 'c2', toolName: 'star', input: {} },
            { type: 'tool-error', toolCallId: 'c2', error: new Error('nope') },
          ],
        },
      ],
      finishReason: 'stop',
    });
    expect(chunks.filter((chunk) => chunk.type === 'tool-input-error')).toHaveLength(1);
    const outputError = chunks.find((chunk) => chunk.type === 'tool-output-error');
    expect(outputError?.errorText).toBe('nope');
  });

  test('falls back to result.text when no step emitted text', () => {
    const chunks = replay({
      text: 'Final answer.',
      finishReason: 'stop',
      steps: [{ content: [] }],
    });
    const delta = chunks.find((chunk) => chunk.type === 'text-delta');
    expect(delta?.delta).toBe('Final answer.');
  });

  test('replays sources, files, and approval requests', () => {
    const chunks = replay({
      finishReason: 'stop',
      steps: [
        {
          content: [
            { type: 'source', sourceType: 'url', id: 's1', url: 'https://example.test', title: 'Example' },
            { type: 'file', file: { url: 'https://example.test/a.png', mediaType: 'image/png' } },
            {
              type: 'tool-approval-request',
              approvalId: 'ap1',
              toolCall: { toolCallId: 'c9', toolName: 'send_message', input: {} },
            },
          ],
        },
      ],
    });
    expect(chunks.find((chunk) => chunk.type === 'source-url')?.url).toBe('https://example.test');
    expect(chunks.find((chunk) => chunk.type === 'file')?.mediaType).toBe('image/png');
    expect(chunks.find((chunk) => chunk.type === 'tool-approval-request')?.approvalId).toBe('ap1');
  });
});
