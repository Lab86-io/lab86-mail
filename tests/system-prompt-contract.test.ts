import { describe, expect, test } from 'bun:test';
import { buildSystemPrompt } from '../lib/ai/system-prompt';

describe('agent system prompt contract', () => {
  test('memories render as a bounded honored block', () => {
    const prompt = buildSystemPrompt(
      { email: 'u@example.com' },
      {
        memories: [
          { email: 'tree@example.com', notes: 'Prefers morning appointments.' },
          { email: 'office@example.com', notes: 'x'.repeat(500) },
        ],
      },
    );
    expect(prompt).toContain('Saved memories');
    expect(prompt).toContain('tree@example.com: Prefers morning appointments.');
    // Notes are clamped so one memory can never flood the prompt: exactly the
    // first 300 characters survive.
    expect(prompt).toContain(`office@example.com: ${'x'.repeat(300)}`);
    expect(prompt).not.toContain('x'.repeat(301));
  });

  test('the split guidance requires a shown proposal before commit', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('albatross_split_work');
    expect(prompt).toContain('commit only after the user confirms');
  });
});
