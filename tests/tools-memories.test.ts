import { describe, expect, test } from 'bun:test';
import './tools/harness';
import { forget, listMemories, recall, remember } from '../lib/tools/memories';
import { runTool } from './tools/harness';

describe('memory tools', () => {
  test('remember, recall, list, and forget round-trip sender notes', async () => {
    const saved = await runTool(remember.handler, {
      email: 'alex@example.test',
      notes: 'Prefers bullet points and morning replies.',
    });
    expect(saved.ok).toBe(true);
    expect(saved.memory.email).toBe('alex@example.test');

    const fetched = await runTool(recall.handler, { email: 'alex@example.test' });
    expect(fetched.memory?.notes).toContain('bullet points');

    const listed = await runTool(listMemories.handler, {});
    expect(listed.memories.some((memory) => memory.email === 'alex@example.test')).toBe(true);

    const removed = await runTool(forget.handler, { email: 'alex@example.test' });
    expect(removed.ok).toBe(true);
    expect((await runTool(recall.handler, { email: 'alex@example.test' })).memory).toBeNull();
  });
});
