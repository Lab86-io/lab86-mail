import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const source = (rel: string) => readFileSync(path.join(process.cwd(), rel), 'utf8');

// Invalidating the disabled summary query did nothing. The shortcut must
// hand the request to the reader, which calls refetch() as its button does.
test('the s shortcut asks the reader to run the summary', () => {
  const shortcuts = source('components/shell/ShortcutsBinding.tsx');
  expect(shortcuts).toContain('requestThreadSummary(selectedThreadId)');
  expect(shortcuts).not.toContain("queryKey: ['summary'");
  const reader = source('components/thread/ThreadView.tsx');
  expect(reader).toContain('claimThreadSummaryRequest(threadId)');
  expect(reader).toContain('void refetchSummary();');
});
