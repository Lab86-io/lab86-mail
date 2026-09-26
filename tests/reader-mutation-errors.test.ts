import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// The reader's Archive and Trash buttons failed silently while the keyboard
// shortcuts showed an error. Every reader mutation must say when it fails.
test('every reader mutation has its own error handler', () => {
  const source = readFileSync(path.join(process.cwd(), 'components/thread/ThreadView.tsx'), 'utf8');
  const blocks = source.split('useMutation({').slice(1);
  expect(blocks.length).toBeGreaterThanOrEqual(3);
  for (const block of blocks) {
    const body = block.slice(0, block.indexOf('\n  });'));
    expect(body).toContain('onError');
  }
  expect(source).toContain("toast.error('Could not archive this thread. Try again.')");
  expect(source).toContain("toast.error('Could not move this thread to Trash. Try again.')");
});
