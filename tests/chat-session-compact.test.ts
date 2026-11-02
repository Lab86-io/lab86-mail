import { describe, expect, test } from 'bun:test';
import { convertToModelMessages } from 'ai';
import { isToolApprovalPart } from '../lib/ai/approval';
import { compactMessage } from '../lib/store/chat-sessions';

describe('compactMessage (persisted chat history)', () => {
  test('large document reads remain valid successful tool results after continuation compaction', async () => {
    for (const name of [
      'document_get',
      'word_document_get',
      'google_document_get',
      'get_thread',
      'read_document',
    ]) {
      const message = compactMessage({
        id: 'assistant',
        role: 'assistant',
        parts: [
          {
            type: `tool-${name}`,
            toolCallId: 'read',
            state: 'output-available',
            input: { documentId: 'deck' },
            output: { text: 'x'.repeat(5000) },
          },
        ],
      });
      expect(message.parts[0].output).toMatchObject({ outputOmitted: true });
      const model = await convertToModelMessages([message]);
      expect(JSON.stringify(model)).toContain('outputOmitted');
      expect(JSON.stringify(model)).not.toContain('x'.repeat(5000));
    }
  });
  test('keeps confirmed outputs and records interrupted server outcomes as unknown', () => {
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
        // A server tool caught mid-flight by a save has an unconfirmed outcome.
        { type: 'tool-mark_read', toolCallId: 'c2', state: 'input-available', input: {} },
      ],
    });
    expect(message.parts[1].state).toBe('output-available');
    expect(message.parts[1].output).toEqual({ threads: [] });
    expect(message.parts[2].state).toBe('output-error');
    expect(message.parts[2].errorText).toContain('outcome not confirmed');
    expect(message.parts[2].output).toBeUndefined();
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

  test('keeps the approval of a call that waits, so a reopened chat shows its card', () => {
    const part = {
      type: 'tool-schedule_send',
      toolCallId: 'send-1',
      state: 'approval-requested',
      input: { to: 'sam@example.test' },
      approval: { id: 'approval-1' },
    };
    const compacted = compactMessage({ id: 'm', role: 'assistant', parts: [part] }).parts[0];
    expect(compacted).toMatchObject({ state: 'approval-requested', approval: { id: 'approval-1' } });
    expect(isToolApprovalPart(compacted)).toBe(true);
    const answered = { ...part, state: 'approval-responded', approval: { id: 'approval-1', approved: true } };
    expect(compactMessage({ id: 'm', role: 'assistant', parts: [answered] }).parts[0].approval).toEqual({
      id: 'approval-1',
      approved: true,
    });
  });

  test('an oversized ok:false stays a failure, never "completed successfully"', () => {
    const compacted = compactMessage({
      id: 'm',
      role: 'assistant',
      parts: [
        {
          type: 'tool-bulk_move_threads',
          toolCallId: 'bulk-1',
          state: 'output-available',
          input: {},
          output: {
            ok: false,
            failed: Array.from({ length: 200 }, (_, id) => ({ threadId: `thread-${id}` })),
          },
        },
      ],
    }).parts[0];
    expect(compacted.output).toMatchObject({ ok: false, outputOmitted: true });
    expect(compacted.output.message).not.toContain('successfully');
    expect(compacted.output.message).toContain('failure');
  });

  test('a call cut off during its input says that it did not run, and it stays valid history', () => {
    const compacted = compactMessage({
      id: 'm',
      role: 'assistant',
      parts: [{ type: 'tool-document_create', toolCallId: 'doc-1', state: 'input-streaming' }],
    }).parts[0];
    expect(compacted.state).toBe('output-error');
    expect(compacted.errorText).toContain('cut off before it ran');
    expect(compacted.input).toEqual({});
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
    expect(message.parts[0].output).toMatchObject({ outputOmitted: true });
    expect(message.parts[0].state).toBe('output-available');
    expect(message.parts[0].input).toEqual({ threadId: 't1' });
  });
});
