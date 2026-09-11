import { describe, expect, test } from 'bun:test';
import {
  agentTimeContext,
  boundedAgentNarrativeContext,
  errorText,
  forwardAgentStream,
  isAuthError,
  isRecoverableAgentProviderError,
  narrativeQueryFromContent,
  narrativeQueryFromMessages,
  safeAuthErrorText,
} from '../lib/ai/loop';

test('bounded agent narrative context preserves identity and falls back on retrieval failure', async () => {
  const calls: unknown[][] = [];
  expect(
    await boundedAgentNarrativeContext('owner', 'Atlas', async (...args) => {
      calls.push(args);
      return 'Relevant context';
    }),
  ).toBe('Relevant context');
  expect(calls).toEqual([['owner', 'Atlas', undefined, expect.any(AbortSignal)]]);
  expect(
    await boundedAgentNarrativeContext('owner', 'Atlas', async () => {
      throw new Error('Context unavailable');
    }),
  ).toBe('');
});

test('chat narrative retrieval carries work and area scope, follows cancellation and keeps short follow-ups grounded', async () => {
  const abort = new AbortController();
  let signal: AbortSignal | undefined;
  let topics: string | string[] | undefined;
  await boundedAgentNarrativeContext(
    'owner',
    'What next?',
    async (_owner, _query, anchors, inputSignal) => {
      topics = anchors;
      signal = inputSignal;
      return 'context';
    },
    ['work:one', 'area:two'],
    abort.signal,
  );
  expect(topics).toEqual(['work:one', 'area:two']);
  abort.abort();
  expect(signal?.aborted).toBe(true);
  expect(
    narrativeQueryFromMessages([
      { role: 'user', content: [{ type: 'file', data: 'PRIVATE', mediaType: 'text/plain' }] },
      { role: 'user', content: 'Atlas launch review' },
      { role: 'assistant', content: 'UNTRUSTED ASSISTANT CLAIM' },
      { role: 'user', content: 'What next?' },
    ]),
  ).toBe('What next? Atlas launch review');
});

test('narrative retrieval uses bounded text rather than attachment or tool payloads', () => {
  expect(narrativeQueryFromContent(undefined)).toBe('');
  expect(narrativeQueryFromContent('x'.repeat(1000))).toHaveLength(240);
  expect(
    narrativeQueryFromContent([
      { type: 'text', text: 'Atlas' },
      { type: 'file', data: 'PRIVATE-BINARY', mediaType: 'text/plain' },
      { type: 'text', text: 'review' },
    ]),
  ).toBe('Atlas review');
});

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

describe('forwardAgentStream (live runtime stream → client)', () => {
  async function* chunks(list: any[]) {
    for (const chunk of list) yield chunk;
  }
  function writer() {
    const written: any[] = [];
    return { written, writer: { write: (chunk: any) => written.push(chunk) } as any };
  }

  test('forwards text, tool input streaming, and tool output in order', async () => {
    const { written, writer: w } = writer();
    const outcome = await forwardAgentStream(
      w,
      chunks([
        { type: 'start-step' },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Search' },
        { type: 'text-delta', id: 't1', delta: 'ing.' },
        { type: 'text-end', id: 't1' },
        { type: 'tool-input-start', toolCallId: 'c1', toolName: 'search_threads' },
        { type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: '{"query":"x"}' },
        { type: 'tool-input-available', toolCallId: 'c1', toolName: 'search_threads', input: { query: 'x' } },
        { type: 'tool-output-available', toolCallId: 'c1', output: { threads: [] } },
        { type: 'finish-step' },
      ]),
    );
    expect(outcome.forwarded).toBe(true);
    expect(outcome.error).toBeUndefined();
    expect(written.map((chunk) => chunk.type)).toEqual([
      'start-step',
      'text-start',
      'text-delta',
      'text-delta',
      'text-end',
      'tool-input-start',
      'tool-input-delta',
      'tool-input-available',
      'tool-output-available',
      'finish-step',
    ]);
  });

  test('a runtime that errors before any content leaves no trace, so the caller can fail over', async () => {
    const { written, writer: w } = writer();
    const boom = Object.assign(new Error('Provider returned error'), { statusCode: 502 });
    const outcome = await forwardAgentStream(
      w,
      chunks([{ type: 'start-step' }, { type: 'error', errorText: 'Provider returned error' }]),
      () => boom,
    );
    expect(outcome.forwarded).toBe(false);
    expect(outcome.error).toBe(boom);
    expect(written).toEqual([]);
  });

  test('an error after content is written through so the client can show it', async () => {
    const { written, writer: w } = writer();
    const outcome = await forwardAgentStream(
      w,
      chunks([
        { type: 'start-step' },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Half' },
        { type: 'error', errorText: 'stream failed' },
      ]),
      () => new Error('stream failed'),
    );
    expect(outcome.forwarded).toBe(true);
    expect(errorText(outcome.error)).toBe('stream failed');
    expect(written.map((chunk) => chunk.type)).toEqual(['start-step', 'text-start', 'text-delta', 'error']);
  });

  test('an empty completion is reported as not forwarded without an error', async () => {
    const { written, writer: w } = writer();
    const outcome = await forwardAgentStream(w, chunks([{ type: 'start-step' }, { type: 'finish-step' }]));
    expect(outcome.forwarded).toBe(false);
    expect(outcome.error).toBeUndefined();
    expect(written).toEqual([]);
  });

  test('reasoning deltas count as content', async () => {
    const { written, writer: w } = writer();
    const outcome = await forwardAgentStream(
      w,
      chunks([
        { type: 'reasoning-start', id: 'r1' },
        { type: 'reasoning-delta', id: 'r1', delta: 'Consider' },
        { type: 'reasoning-end', id: 'r1' },
      ]),
    );
    expect(outcome.forwarded).toBe(true);
    expect(written.map((chunk) => chunk.type)).toEqual([
      'reasoning-start',
      'reasoning-delta',
      'reasoning-end',
    ]);
  });
});

describe('agentTimeContext', () => {
  test('rounds to the minute so the prompt prefix is stable within a step burst', () => {
    const a = agentTimeContext('America/New_York', new Date('2026-09-11T14:05:07Z'));
    const b = agentTimeContext('America/New_York', new Date('2026-09-11T14:05:52Z'));
    expect(a).toBe(b);
    expect(a).toContain("The user's timezone is America/New_York.");
    expect(a).toContain('Never append Z to a local wall-clock time.');
    expect(a).not.toMatch(/:\d\d:\d\d/);
  });
});
