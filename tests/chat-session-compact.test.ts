import { describe, expect, test } from 'bun:test';
import { compactMessage } from '../lib/store/chat-sessions';

describe('compactMessage (persisted chat history)', () => {
  test('keeps small tool outputs and completes interrupted server tools', () => {
    const message = compactMessage({
      role: 'assistant',
      parts: [
        { type: 'text', text: 'Done.' },
        {
          type: 'tool-search_threads',
          toolCallId: 'c1',
          state: 'output-available',
          input: { query: 'x' },
          output: { threads: [] },
        },
        // A server tool caught mid-flight by a save: render as completed.
        { type: 'tool-mark_read', toolCallId: 'c2', state: 'input-available', input: {} },
      ],
    });
    expect(message.parts[1].state).toBe('output-available');
    expect(message.parts[1].output).toEqual({ threads: [] });
    expect(message.parts[2].state).toBe('output-available');
  });

  test('never rewrites an unanswered human-in-the-loop pause as answered', () => {
    // Faking output-available here makes a restored session auto-continue and
    // re-run every mutating tool in the follow-up turn on each reload.
    const message = compactMessage({
      role: 'assistant',
      parts: [
        {
          type: 'tool-ask_user',
          toolCallId: 'q1',
          state: 'input-available',
          input: { questions: [{ question: 'Which day?' }] },
        },
        {
          type: 'dynamic-tool',
          toolName: 'ask_approval',
          toolCallId: 'q2',
          state: 'input-available',
          input: { title: 'Send it?' },
        },
      ],
    });
    expect(message.parts[0].state).toBe('input-available');
    expect(message.parts[1].state).toBe('input-available');
  });

  test('keeps an answered pause with its output intact', () => {
    const message = compactMessage({
      role: 'assistant',
      parts: [
        {
          type: 'tool-ask_user',
          toolCallId: 'q1',
          state: 'output-available',
          input: { questions: [{ question: 'Which day?' }] },
          output: { answers: [{ question: 'Which day?', response: 'Wednesday' }] },
        },
      ],
    });
    expect(message.parts[0].state).toBe('output-available');
    expect(message.parts[0].output.answers[0].response).toBe('Wednesday');
  });

  test('drops oversized outputs but keeps the part shape', () => {
    const message = compactMessage({
      role: 'assistant',
      parts: [
        {
          type: 'tool-get_thread',
          toolCallId: 'c1',
          state: 'output-available',
          input: { threadId: 't1' },
          output: { body: 'x'.repeat(10_000) },
        },
      ],
    });
    expect(message.parts[0].output).toBeUndefined();
    expect(message.parts[0].state).toBe('output-available');
    expect(message.parts[0].input).toEqual({ threadId: 't1' });
  });
});
