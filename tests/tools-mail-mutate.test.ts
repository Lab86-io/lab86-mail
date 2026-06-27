import { describe, expect, test } from 'bun:test';
import './tools/harness';
import { listDueSnoozes } from '../lib/store/snooze';
import { getThread } from '../lib/store/threads';
import {
  archiveThread,
  markThreadRead,
  setSmartCategoryTool,
  snoozeThreadTool,
  unsnoozeThreadTool,
} from '../lib/tools/mail-mutate';
import { runTool, seedThreadMessage, withToolContext } from './tools/harness';

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
    const thread = await withToolContext(() => getThread(account, threadId));
    expect(thread?.smartCategory).toMatchObject({
      primary: 'review',
      reason: 'User flagged for review',
      model: 'user',
    });
  });

  test('snooze and unsnooze messages locally', async () => {
    const { account, messageId, threadId } = await seedThreadMessage();
    const untilTs = Date.parse('2026-06-12T09:00:00.000Z');
    const snoozed = await runTool(snoozeThreadTool.handler, { account, messageId, threadId, untilTs });
    expect(snoozed.ok).toBe(true);
    expect(snoozed.untilIso).toBe(new Date(untilTs).toISOString());

    const unsnoozed = await runTool(unsnoozeThreadTool.handler, { account, messageId });
    expect(unsnoozed.ok).toBe(true);
    const snoozes = await withToolContext(() => listDueSnoozes(Number.POSITIVE_INFINITY));
    expect(snoozes.some((snooze) => snooze.account === account && snooze.messageId === messageId)).toBe(
      false,
    );
  });
});

describe('mail mutate tools — Nylas guards', () => {
  test('provider mutations fail clearly without a connected account', async () => {
    const { account, threadId } = await seedThreadMessage();
    await expect(runTool(archiveThread.handler, { account, threadId })).rejects.toThrow(
      /Nylas account|Convex/,
    );
    await expect(runTool(markThreadRead.handler, { account, threadId })).rejects.toThrow(
      /Nylas account|Convex/,
    );
  });
});
