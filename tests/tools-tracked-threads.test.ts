import { describe, expect, test } from 'bun:test';
import './tools/harness';
import {
  getTrackedThreadTool,
  listTrackedThreadsTool,
  resolveTrackedThread,
  trackThread,
  updateTrackedThreadTool,
} from '../lib/tools/tracked-threads';
import { runTool, seedThreadMessage } from './tools/harness';

describe('tracked thread tools', () => {
  test('tracks, updates, resolves, and lists conversations', async () => {
    const { account, threadId } = await seedThreadMessage({
      subject: 'Contract review',
      from: 'Legal <legal@example.test>',
    });

    const tracked = await runTool(trackThread.handler, {
      account,
      threadId,
      reason: 'Needs signature this week',
      status: 'open',
      importance: 1,
      openLoops: ['Send redlines'],
    });
    expect(tracked.tracked.reason).toContain('signature');

    const fetched = await runTool(getTrackedThreadTool.handler, { account, threadId });
    expect(fetched.tracked?._id).toBe(tracked.tracked._id);

    const updated = await runTool(updateTrackedThreadTool.handler, {
      id: tracked.tracked._id,
      status: 'waiting',
      nextAction: 'Wait for counterparty',
    });
    expect(updated.tracked.status).toBe('waiting');

    const listed = await runTool(listTrackedThreadsTool.handler, { includeResolved: false });
    expect(listed.tracked.some((row: any) => row._id === tracked.tracked._id)).toBe(true);

    const resolved = await runTool(resolveTrackedThread.handler, {
      id: tracked.tracked._id,
      reason: 'Signed',
    });
    expect(resolved.tracked.status).toBe('resolved');
  });
});
