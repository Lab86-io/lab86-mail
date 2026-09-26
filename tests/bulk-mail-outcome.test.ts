import { expect, test } from 'bun:test';
import { bulkMailMessages, settleBulk } from '../lib/shell/bulk-mail';

test('a partial failure reports both the moved and the failed counts', async () => {
  const outcome = await settleBulk(['a', 'b', 'c'], async (id) => {
    if (id === 'b') throw new Error('Provider rejected');
    return { ok: true };
  });
  expect(outcome).toEqual({ succeeded: ['a', 'c'], failed: ['b'] });
  expect(bulkMailMessages('archive', outcome)).toEqual({
    success: 'Archived 2 threads',
    error: 'Could not archive 1 thread. It is back in the list.',
  });
});

test('full success and full failure each show one message', async () => {
  expect(bulkMailMessages('trash', { succeeded: ['a'], failed: [] })).toEqual({
    success: 'Moved 1 thread to Trash',
    error: null,
  });
  expect(bulkMailMessages('trash', { succeeded: [], failed: ['a', 'b'] })).toEqual({
    success: null,
    error: 'Could not trash 2 threads. They are back in the list.',
  });
});
