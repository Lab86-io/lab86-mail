import { describe, expect, test } from 'bun:test';
import './tools/harness';
import {
  deleteDraftTool,
  forwardMessage,
  listDraftsTool,
  replyAllMessage,
  replyMessage,
  saveDraftTool,
  scheduleSend,
  sendMessage,
  updateDraft,
} from '../lib/tools/compose';
import { runTool, seedThreadMessage } from './tools/harness';

describe('compose tools', () => {
  test('save, list, update, and delete local drafts', async () => {
    const saved = await runTool(saveDraftTool.handler, {
      account: 'jakob@example.test',
      to: 'alex@example.test',
      subject: 'Draft subject',
      body: 'Draft body',
    });
    expect(saved.ok).toBe(true);
    expect(saved.draft._id).toBeTruthy();

    const listed = await runTool(listDraftsTool.handler, { account: 'jakob@example.test' });
    expect(listed.drafts.some((draft: any) => draft._id === saved.draft._id)).toBe(true);

    const updated = await runTool(updateDraft.handler, {
      id: saved.draft._id,
      patch: { body: 'Updated body' },
    });
    expect(updated.ok).toBe(true);

    const deleted = await runTool(deleteDraftTool.handler, { id: saved.draft._id });
    expect(deleted.ok).toBe(true);
  });

  test('reply and reply_all require cached anchor messages', async () => {
    const { account, messageId, threadId } = await seedThreadMessage({
      from: 'Alex <alex@example.test>',
      to: 'Jakob <jakob@example.test>',
      subject: 'Question',
    });

    await expect(
      runTool(replyMessage.handler, { account, messageId: 'missing', body: 'Hi' }),
    ).rejects.toThrow(/local cache/);

    await expect(
      runTool(replyMessage.handler, { account, messageId, threadId, body: 'Thanks' }),
    ).rejects.toThrow(/Nylas|Convex/);

    await expect(
      runTool(replyAllMessage.handler, { account, messageId, threadId, body: 'Thanks all' }),
    ).rejects.toThrow(/Nylas|Convex/);
  });

  test('forward builds quoted content from cached messages', async () => {
    const { account, messageId } = await seedThreadMessage({
      subject: 'Original',
      textBody: 'Please review this doc.',
    });
    await expect(
      runTool(forwardMessage.handler, {
        account,
        messageId,
        to: 'team@example.test',
        body: 'FYI',
      }),
    ).rejects.toThrow(/Nylas|Convex/);
  });

  test('send and schedule require Nylas', async () => {
    await expect(
      runTool(sendMessage.handler, {
        account: 'jakob@example.test',
        to: 'alex@example.test',
        subject: 'Hello',
        body: 'Body',
      }),
    ).rejects.toThrow(/Nylas|Convex/);

    await expect(
      runTool(scheduleSend.handler, {
        account: 'jakob@example.test',
        to: 'alex@example.test',
        subject: 'Later',
        body: 'Body',
        scheduledFor: Date.now() + 120_000,
      }),
    ).rejects.toThrow(/Nylas|Convex/);
  });

  test('schedule_send rejects near-term timestamps', async () => {
    await expect(
      runTool(scheduleSend.handler, {
        account: 'jakob@example.test',
        to: 'alex@example.test',
        subject: 'Too soon',
        body: 'Body',
        scheduledFor: Date.now() + 5_000,
      }),
    ).rejects.toThrow(/at least a minute/);
  });
});
