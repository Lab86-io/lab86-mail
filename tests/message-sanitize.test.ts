import { describe, expect, test } from 'bun:test';
import { sanitizeToolPairs } from '../lib/ai/message-sanitize';

describe('sanitizeToolPairs', () => {
  test('keeps a valid call/result pair', () => {
    const msgs = [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'a', toolName: 'foo' }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'a', result: {} }] },
    ];
    expect(sanitizeToolPairs(msgs)).toHaveLength(2);
  });

  test('drops an orphaned tool-call but keeps the assistant text', () => {
    const msgs = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'working on it' },
          { type: 'tool-call', toolCallId: 'orphan', toolName: 'foo' },
        ],
      },
    ];
    const out = sanitizeToolPairs(msgs);
    expect(out).toHaveLength(1);
    expect(out[0].content).toEqual([{ type: 'text', text: 'working on it' }]);
  });

  test('drops a message that was only an orphaned tool-call', () => {
    const msgs = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'orphan', toolName: 'foo' }] },
      { role: 'user', content: 'continue' },
    ];
    const out = sanitizeToolPairs(msgs);
    expect(out).toHaveLength(2);
    expect(out.map((m: any) => m.role)).toEqual(['user', 'user']);
  });

  test('drops an orphaned tool-result (call was compacted away)', () => {
    const msgs = [
      { role: 'assistant', content: [{ type: 'text', text: '[compacted]' }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'gone', result: {} }] },
    ];
    const out = sanitizeToolPairs(msgs);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('assistant');
  });

  test('leaves string-content and plain messages untouched', () => {
    const msgs = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ];
    expect(sanitizeToolPairs(msgs)).toEqual(msgs);
  });
});
