import { describe, expect, test } from 'bun:test';
import './tools/harness';
import { promptNoteFor } from '../components/ai-elements/shapes/shape-shell';
import { MEMORY_NOTES_MAX_CHARS, mergeMemoryNotes } from '../lib/store/memories';
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

  test('a new memory adds to the saved note instead of deleting it', async () => {
    const email = 'me@example.test';
    await runTool(remember.handler, { email, notes: 'Sign off as J.' });
    await runTool(remember.handler, { email, notes: 'Use metric units.' });
    // Repeating a note does not add a second copy.
    const again = await runTool(remember.handler, { email, notes: 'Use metric units.' });
    expect(again.memory.notes).toBe('Sign off as J.\nUse metric units.');
    expect((await runTool(recall.handler, { email })).memory?.notes).toBe(
      'Sign off as J.\nUse metric units.',
    );

    const replaced = await runTool(remember.handler, { email, notes: 'Sign off as Jakob.', mode: 'replace' });
    expect(replaced.memory.notes).toBe('Sign off as Jakob.');
    await runTool(forget.handler, { email });
  });

  test('the tool input defaults to append and accepts replace', () => {
    expect(remember.input.parse({ email: 'a@x.test', notes: 'n' }).mode).toBe('append');
    expect(remember.input.safeParse({ email: 'a@x.test', notes: 'n', mode: 'replace' }).success).toBe(true);
    expect(remember.input.safeParse({ email: 'a@x.test', notes: 'n', mode: 'wipe' }).success).toBe(false);
  });

  test('appended notes stay bounded and drop the oldest lines first', () => {
    const old = Array.from({ length: 60 }, (_, index) => `old note ${index} ${'x'.repeat(80)}`).join('\n');
    const merged = mergeMemoryNotes(old, 'newest note');
    expect(merged.length).toBeLessThanOrEqual(MEMORY_NOTES_MAX_CHARS);
    expect(merged.endsWith('newest note')).toBe(true);
    expect(merged).not.toContain('old note 0 ');
    expect(mergeMemoryNotes('', '  first  ')).toBe('first');
    expect(mergeMemoryNotes('kept', '   ')).toBe('kept');
  });

  test('the sender card note field starts from the saved note', () => {
    expect(promptNoteFor({ kind: 'remember_sender', email: 'a@x.test', notes: 'Likes brevity' })).toBe(
      'Likes brevity',
    );
    expect(promptNoteFor({ kind: 'remember_sender', email: 'a@x.test' })).toBe('');
    expect(promptNoteFor({ kind: 'open_work', workId: 'w' })).toBe('');
  });
});
