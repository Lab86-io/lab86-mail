import { describe, expect, test } from 'bun:test';
import {
  groupMessageParts,
  reasoningLabel,
  shouldCollapseWorkLog,
  toolPartSignature,
  workLogHeader,
} from '../lib/chat/work-log';

const tool = (id: string, state = 'output-available') => ({
  type: 'tool-search_threads',
  toolCallId: id,
  state,
  input: { query: 'invoice' },
  output: { ok: true },
});

describe('chat work log', () => {
  test('groups calls across step markers and attaches shapes by call ID', () => {
    const shape = { kind: 'count', title: 'Matches', value: 2, label: 'threads', actions: [] };
    const parts = [
      tool('a'),
      { type: 'step-start' },
      { type: 'text', text: '' },
      tool('b'),
      { type: 'text', text: 'Reply' },
      { type: 'data-tool-shape', id: 'a', data: shape },
    ];
    const segments = groupMessageParts(parts);
    expect(segments).toHaveLength(2);
    const first = segments[0];
    if (first.kind !== 'work-log') throw new Error('Expected work log');
    expect(first.rows.map((row) => row.toolCallId)).toEqual(['a', 'b']);
    expect(first.rows[0].shape).toEqual(shape);
    expect(segments[1].kind).toBe('part');
    expect(parts[0]).not.toHaveProperty('shape');
  });

  test('keeps human input outside each log and supports dynamic calls', () => {
    const parts = [
      tool('a'),
      { type: 'tool-ask_user', toolCallId: 'ask', input: { questions: [] } },
      { type: 'dynamic-tool', toolName: 'read_thread', toolCallId: 'b', state: 'input-streaming' },
    ];
    expect(groupMessageParts(parts).map((segment) => segment.kind)).toEqual(['work-log', 'part', 'work-log']);
  });

  test('collapses only completed groups without failures', () => {
    const segment = groupMessageParts([tool('a'), tool('b'), tool('c')])[0];
    if (segment.kind !== 'work-log') throw new Error('Expected work log');
    expect(shouldCollapseWorkLog(segment.rows, false)).toBe(false);
    expect(shouldCollapseWorkLog(segment.rows, true)).toBe(true);
    expect(workLogHeader(segment.rows, true, 6000).text).toBe('Did 3 things · 6s');
    segment.rows[0].state = 'running';
    expect(workLogHeader(segment.rows, false).text).toBe('Working');
    segment.rows[0].state = 'failed';
    expect(shouldCollapseWorkLog(segment.rows, true)).toBe(false);
    expect(workLogHeader(segment.rows, true).text).toBe('1 step failed');
  });

  test('text deltas do not retrigger tool effects', () => {
    const messages = [{ id: 'a', parts: [tool('a'), { type: 'text', text: 'one' }] }];
    const before = toolPartSignature(messages);
    messages[0].parts[1] = { type: 'text', text: 'one two three' };
    expect(toolPartSignature(messages)).toBe(before);
    messages[0].parts[0] = tool('a', 'output-error');
    expect(toolPartSignature(messages)).not.toBe(before);
    expect(reasoningLabel(true, 2500)).toBe('Thought');
    expect(reasoningLabel(false, 3100)).toBe('Thought for 3s');
    expect(reasoningLabel(false)).toBe('Thought');
  });
});
