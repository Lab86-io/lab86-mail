import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const source = (rel: string) => readFileSync(path.join(process.cwd(), rel), 'utf8');

// Custom labels match whole words from the name and the example words; the
// description is not matched. The label creation copy must say so.
test('label creation copy describes whole-word keyword matching', () => {
  for (const file of ['components/inbox/Inbox.tsx', 'components/inbox/SmartLabelsSettings.tsx']) {
    const text = source(file);
    expect(text).not.toContain('What should this label match?');
    expect(text).not.toMatch(/teach it with examples/i);
    expect(text).toContain('not used for matching');
    expect(text).toMatch(/whole words/);
  }
});
