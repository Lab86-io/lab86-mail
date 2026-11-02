import { describe, expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import {
  boundToolResults,
  MAX_TOOL_RESULT_BYTES,
  MAX_TOOL_RESULTS_TOTAL_BYTES,
  toolModelOutput,
  toolResultCapFor,
} from '../lib/ai/tool-result-cap';

function result(toolCallId: string, output: unknown, toolName = 'read_thread'): ModelMessage {
  return { role: 'tool', content: [{ type: 'tool-result', toolCallId, toolName, output: output as any }] };
}

describe('toolModelOutput', () => {
  test('a small result goes to the model as it is', () => {
    expect(toolModelOutput('read_thread', { ok: true })).toEqual({ type: 'json', value: { ok: true } });
    expect(toolModelOutput('read_thread', 'plain')).toEqual({ type: 'text', value: 'plain' });
    expect(toolModelOutput('read_thread', undefined)).toEqual({ type: 'json', value: null });
  });

  test('a large result is cut with a note first, inside the byte cap plus the note', () => {
    const output = toolModelOutput('read_thread', { ok: false, body: 'é'.repeat(100_000) });
    expect(output.type).toBe('text');
    const text = output.value as string;
    expect(text.startsWith('[This result was cut')).toBe(true);
    expect(text).toContain('ok: false');
    expect(text).toContain('Ask for less');
    expect(Buffer.byteLength(text)).toBeLessThan(MAX_TOOL_RESULT_BYTES + 400);
    // The cut never splits a character.
    expect(text).not.toContain('�');
  });

  test('a read of a whole document has more room', () => {
    expect(toolResultCapFor('document_get')).toBeGreaterThan(toolResultCapFor('read_thread'));
    const output = { document: 'x'.repeat(100_000) };
    expect(toolModelOutput('document_get', output).type).toBe('json');
    expect(toolModelOutput('read_thread', output).type).toBe('text');
  });
});

describe('boundToolResults', () => {
  test('a prompt inside the caps comes back as the same array', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'Hi' },
      result('a', { type: 'json', value: { ok: true } }),
    ];
    expect(boundToolResults(messages)).toBe(messages);
  });

  test('one large stored result is cut and keeps its failure', () => {
    const [bounded] = boundToolResults([
      result('a', { type: 'json', value: { ok: false, body: 'x'.repeat(100_000) } }),
    ]) as any[];
    const output = bounded.content[0].output;
    expect(output.type).toBe('text');
    expect(output.value).toContain('ok: false');
    expect(output.value.length).toBeLessThan(MAX_TOOL_RESULT_BYTES + 400);
    const [text] = boundToolResults([result('b', { type: 'text', value: 'y'.repeat(100_000) })]) as any[];
    expect(text.content[0].output.value).toContain('yyyy');
  });

  test('the oldest results go first until all results fit, and the newest stays whole', () => {
    const big = (id: string) => result(id, { type: 'json', value: { body: 'z'.repeat(60_000) } });
    const messages = [
      { role: 'user', content: 'Long text stays' } as ModelMessage,
      big('a'),
      big('b'),
      big('c'),
      big('d'),
      big('e'),
    ];
    const bounded = boundToolResults(messages) as any[];
    expect(bounded[0]).toBe(messages[0]);
    expect(bounded[1].content[0].output.value).toContain('Older result omitted');
    expect(bounded[2].content[0].output.value).toContain('Older result omitted');
    expect(bounded[5].content[0].output.type).toBe('json');
    expect(JSON.stringify(bounded.slice(1)).length).toBeLessThan(MAX_TOOL_RESULTS_TOTAL_BYTES + 2_000);
  });

  test('an omitted failure still says that it failed', () => {
    const failed = result('a', { type: 'json', value: { ok: false, body: 'z'.repeat(1_000) } });
    const bounded = boundToolResults(
      [failed, result('b', { type: 'text', value: 'n'.repeat(500) })],
      800,
    ) as any[];
    expect(bounded[0].content[0].output.value).toContain('ok: false');
    expect(bounded[1].content[0].output.value).toBe('n'.repeat(500));
  });

  test('a message without tool results stays', () => {
    const text: ModelMessage = { role: 'assistant', content: 'Done.' };
    expect(boundToolResults([text], 1)).toEqual([text]);
    const approval = {
      role: 'tool',
      content: [{ type: 'tool-approval-response', approvalId: 'a', approved: true }],
    } as ModelMessage;
    expect(boundToolResults([approval], 1)).toEqual([approval]);
  });
});
