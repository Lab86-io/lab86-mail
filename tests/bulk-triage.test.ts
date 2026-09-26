import { expect, test } from 'bun:test';
import './tools/harness';
import {
  BULK_TRIAGE_CHUNK,
  type BulkTriageItem,
  bulkTriageMessage,
  chunk,
  runBulkTriage,
} from '../lib/shell/bulk-triage';
import { getThread } from '../lib/store/threads';
import { BULK_TRIAGE_LIMIT, bulkTriage, saveBulkTriageVerdicts } from '../lib/tools/ai';
import { runTool, seedThreadMessage, withToolContext } from './tools/harness';

const rows = (count: number): BulkTriageItem[] =>
  Array.from({ length: count }, (_, index) => ({ id: `t${index}`, account: 'a@example.test' }));

test('the client chunk size matches the tool input limit', () => {
  expect(BULK_TRIAGE_CHUNK).toBe(BULK_TRIAGE_LIMIT);
  expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  expect(() => chunk([1], 0)).toThrow();
});

test('a 50-row selection is split into groups the tool accepts', async () => {
  const sizes: number[] = [];
  const outcome = await runBulkTriage(rows(50), async (group) => {
    sizes.push(group.length);
    return { verdicts: group, model: 'fast', saved: group.length };
  });
  expect(sizes).toEqual([40, 10]);
  expect(outcome).toEqual({ total: 50, saved: 50, failed: 0, noModel: false, firstError: null });
  expect(bulkTriageMessage(outcome)).toEqual({ kind: 'success', text: 'Triaged 50' });
});

test('a failed group is counted and reported, and the other groups still run', async () => {
  let calls = 0;
  const outcome = await runBulkTriage(rows(50), async (group) => {
    calls += 1;
    if (calls === 1) throw new Error('Rate limited');
    return { verdicts: group, model: 'fast' };
  });
  expect(outcome.failed).toBe(40);
  expect(outcome.saved).toBe(0);
  expect(outcome.firstError).toBe('Rate limited');
  expect(bulkTriageMessage(outcome)).toEqual({
    kind: 'error',
    text: 'Triaged 10 of 50. 40 could not be triaged.',
  });
  const all = await runBulkTriage(rows(1), async () => {
    throw new Error('down');
  });
  expect(bulkTriageMessage(all)).toEqual({ kind: 'error', text: 'Could not triage this thread.' });
  const many = await runBulkTriage(rows(2), async () => {
    throw 'down';
  });
  expect(many.firstError).toBe('down');
  expect(bulkTriageMessage(many).text).toBe('Could not triage these threads.');
});

test('with no model set up, the run stops and says so instead of claiming success', async () => {
  let calls = 0;
  const outcome = await runBulkTriage(rows(50), async (group) => {
    calls += 1;
    return { verdicts: group, model: 'local' };
  });
  expect(calls).toBe(1);
  expect(outcome.noModel).toBe(true);
  expect(bulkTriageMessage(outcome)).toEqual({
    kind: 'info',
    text: 'Set up a model in Settings, Intelligence, to triage mail.',
  });
});

test('bulk verdicts are saved on their threads through the triage store', async () => {
  const { account, threadId } = await seedThreadMessage({
    threadId: 'bulk-save-1',
    messageId: 'bulk-save-m1',
  });
  const saved = await withToolContext(() =>
    saveBulkTriageVerdicts(
      [{ id: threadId, account }, { id: 'no-account' }],
      [
        { id: threadId, priority: 1, action: 'reply', reason: 'Asks for a date' },
        { id: 'no-account', priority: 3, action: 'archive', reason: 'x' },
        { id: 'invented-id', priority: 3, action: 'archive', reason: 'x' },
      ],
    ),
  );
  expect(saved).toBe(1);
  const thread = await withToolContext(() => getThread(account, threadId));
  expect(thread?.triage).toMatchObject({ priority: 1, action: 'reply', reason: 'Asks for a date' });
});

test('placeholder verdicts with no model are not saved on the thread', async () => {
  const { account, threadId } = await seedThreadMessage({
    threadId: 'bulk-save-2',
    messageId: 'bulk-save-m2',
  });
  const batch = await runTool(bulkTriage.handler, { items: [{ id: threadId, account }] });
  expect(batch.model).toBe('local');
  const thread = await withToolContext(() => getThread(account, threadId));
  expect(thread?.triage ?? null).toBeNull();
});
