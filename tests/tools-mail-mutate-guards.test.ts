import { describe, expect, test } from 'bun:test';
import './tools/harness';
import {
  addLabel,
  applySmartLabels,
  markRead,
  markUnread,
  muteThread,
  removeLabel,
  restoreFromTrash,
  starMessage,
  trashThread,
  unsnoozeThreadTool,
  unstarMessage,
} from '../lib/tools/mail-mutate';
import { runTool, seedThreadMessage } from './tools/harness';

// The native mail list sends its actions through the mobile command outbox,
// and the executor runs these tools. Without a connected provider account a
// tool must fail, so the command records a failure instead of "applied".

describe('mail mutation tools without a connected account', () => {
  test('thread moves fail clearly', async () => {
    const { account, threadId } = await seedThreadMessage({ threadId: 'thread_guard_move' });
    for (const tool of [trashThread, restoreFromTrash, muteThread]) {
      await expect(runTool(tool.handler, { account, threadId })).rejects.toThrow(/Nylas account|Convex/);
    }
  });

  test('message flag and label changes fail clearly', async () => {
    const { account, messageId } = await seedThreadMessage({
      threadId: 'thread_guard_flags',
      messageId: 'msg_guard_flags',
    });
    for (const tool of [markRead, markUnread, starMessage, unstarMessage]) {
      await expect(runTool(tool.handler, { account, messageId })).rejects.toThrow(/Nylas account|Convex/);
    }
    for (const tool of [addLabel, removeLabel]) {
      await expect(runTool(tool.handler, { account, messageId, label: 'MailOS/Receipts' })).rejects.toThrow(
        /Nylas account|Convex/,
      );
    }
  });

  test('smart labels fail before any label is applied', async () => {
    const { account, threadId, messageId } = await seedThreadMessage({
      threadId: 'thread_guard_smart',
      messageId: 'msg_guard_smart',
    });
    await expect(
      runTool(applySmartLabels.handler, {
        account,
        items: [{ threadId, messageId, labels: ['MailOS/Receipts'] }],
      }),
    ).rejects.toThrow(/Nylas account|Convex/);
  });

  test('unsnooze needs a signed-in user and then a store', async () => {
    const { account, threadId } = await seedThreadMessage({ threadId: 'thread_guard_wake' });
    await expect(
      runTool(unsnoozeThreadTool.handler, { account, threadId }, { userId: undefined }),
    ).rejects.toThrow('Sign in required to unsnooze mail.');
    await expect(runTool(unsnoozeThreadTool.handler, { account, threadId })).rejects.toThrow();
  });
});
