import { describe, expect, test } from 'bun:test';
import './tools/harness';
import { getTrackedThreadById, listTrackedThreads, upsertTrackedThread } from '../lib/store/tracked-threads';
import { resolveTrackedThread, updateTrackedThreadTool } from '../lib/tools/tracked-threads';
import { runTool, seedThreadMessage, withToolContext } from './tools/harness';

describe('tracked thread tools', () => {
  test('updates and resolves a conversation the brief tracks', async () => {
    const { account, threadId } = await seedThreadMessage({
      subject: 'Contract review',
      from: 'Legal <legal@example.test>',
    });
    // The daily report is the only writer of tracked threads.
    const tracked = await withToolContext(() =>
      upsertTrackedThread({
        account,
        threadId,
        subject: 'Contract review',
        reason: 'Needs signature this week',
        status: 'open',
        importance: 1,
        openLoops: ['Send redlines'],
      }),
    );

    const updated = await runTool(updateTrackedThreadTool.handler, {
      id: tracked._id,
      status: 'waiting',
      nextAction: 'Wait for counterparty',
    });
    expect(updated.tracked.status).toBe('waiting');
    expect((await withToolContext(() => getTrackedThreadById(tracked._id)))?.nextAction).toBe(
      'Wait for counterparty',
    );

    const resolved = await runTool(resolveTrackedThread.handler, {
      id: tracked._id,
      reason: 'Signed',
    });
    expect(resolved.tracked.status).toBe('resolved');
    const open = await withToolContext(() => listTrackedThreads({ includeResolved: false }));
    expect(open.some((row) => row._id === tracked._id)).toBe(false);
  });
});
