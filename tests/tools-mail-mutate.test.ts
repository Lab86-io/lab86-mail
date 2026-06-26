import { describe, expect, test } from 'bun:test';
import './tools/harness';
import {
  archiveThread,
  markThreadRead,
  setSmartCategoryTool,
  snoozeThreadTool,
  unsnoozeThreadTool,
} from '../lib/tools/mail-mutate';
import { runTool, seedThreadMessage } from './tools/harness';

describe('mail mutate tools — local paths', () => {
  test('set_smart_category stores a local override', async () => {
    const { account, threadId } = await seedThreadMessage();
    const result = await runTool(setSmartCategoryTool.handler, {
      account,
      threadId,
      category: 'review',
      reason: 'User flagged for review',
    });
    expect(result.ok).toBe(true);
  });

  test('snooze and unsnooze messages locally', async () => {
    const { account, messageId, threadId } = await seedThreadMessage();
    const untilTs = Date.parse('2026-06-12T09:00:00.000Z');
    const snoozed = await runTool(snoozeThreadTool.handler, { account, messageId, threadId, untilTs });
    expect(snoozed.ok).toBe(true);
    expect(snoozed.untilIso).toBe(new Date(untilTs).toISOString());

    const unsnoozed = await runTool(unsnoozeThreadTool.handler, { account, messageId });
    expect(unsnoozed.ok).toBe(true);
  });
});

describe('mail mutate tools — Nylas guards', () => {
  test('provider mutations fail clearly without a connected account', async () => {
    const { account, threadId, messageId } = await seedThreadMessage();
    await expect(runTool(archiveThread.handler, { account, threadId })).rejects.toThrow(/Nylas account|Convex/);
    await expect(runTool(markThreadRead.handler, { account, threadId })).rejects.toThrow(/Nylas account|Convex/);
  });
});
