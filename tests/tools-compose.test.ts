import { describe, expect, test } from 'bun:test';
import './tools/harness';
import { getDraft } from '../lib/store/drafts';
import { getMessage } from '../lib/store/messages';
import {
  buildForwardMessagePayload,
  deleteDraftTool,
  forwardMessage,
  listDraftsTool,
  recordSavedDraftOperation,
  replyAllMessage,
  replyMessage,
  saveDraftAndRecordOperation,
  saveDraftTool,
  scheduleSend,
  sendMessage,
  updateDraft,
} from '../lib/tools/compose';
import { runTool, seedThreadMessage, withToolContext } from './tools/harness';

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
    await expect(withToolContext(() => getDraft(saved.draft._id))).resolves.toMatchObject({
      body: 'Updated body',
    });

    const deleted = await runTool(deleteDraftTool.handler, { id: saved.draft._id });
    expect(deleted.ok).toBe(true);
    await expect(withToolContext(() => getDraft(saved.draft._id))).resolves.toBeNull();
  });

  test('save_draft operation metadata records an undoable draft target when hosted operations are configured', async () => {
    const previousUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
    const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.NEXT_PUBLIC_CONVEX_URL = 'http://127.0.0.1:32123';
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'test-secret';
    const operationInputs: any[] = [];
    try {
      const operationId = await recordSavedDraftOperation(
        {
          ctx: { userId: 'test_user_tools', operationBatchId: 'batch_draft' },
          args: { subject: 'Tracked draft' },
          saved: { _id: 'draft_1', account: 'jakob@example.test' },
        },
        async (input: any) => {
          operationInputs.push(input);
          return 'operation_draft_1';
        },
      );
      expect(operationId).toBe('operation_draft_1');
      expect(operationInputs[0]).toMatchObject({
        userId: 'test_user_tools',
        tool: 'save_draft',
        surface: 'mail',
        summary: 'Saved draft "Tracked draft"',
        inverse: { kind: 'compose.delete_draft' },
        batchId: 'batch_draft',
      });
      expect(operationInputs[0].target).toMatchObject({
        kind: 'emailDraft',
        id: 'draft_1',
        accountId: 'jakob@example.test',
      });
    } finally {
      if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_CONVEX_URL;
      else process.env.NEXT_PUBLIC_CONVEX_URL = previousUrl;
      if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
    }
  });

  test('save_draft skips operation metadata outside hosted operation mode', async () => {
    const previousUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
    const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    delete process.env.NEXT_PUBLIC_CONVEX_URL;
    delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
    const operationInputs: any[] = [];
    try {
      const operationId = await recordSavedDraftOperation(
        {
          ctx: { userId: 'test_user_tools' },
          args: { subject: 'Local draft' },
          saved: { _id: 'draft_2', account: 'jakob@example.test' },
        },
        async (input: any) => {
          operationInputs.push(input);
          return 'operation_draft_2';
        },
      );
      expect(operationId).toBeUndefined();
      expect(operationInputs).toHaveLength(0);
    } finally {
      if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_CONVEX_URL;
      else process.env.NEXT_PUBLIC_CONVEX_URL = previousUrl;
      if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
    }
  });

  test('save_draft rolls back the local draft when operation recording fails', async () => {
    const deleted: string[] = [];
    let failed = false;
    try {
      await saveDraftAndRecordOperation(
        {
          ctx: { userId: 'test_user_tools' },
          doc: {
            _id: 'draft_rollback',
            account: 'jakob@example.test',
            to: 'alex@example.test',
            subject: 'Rollback draft on operation failure',
            body: 'Draft body',
            updatedAt: 1,
          },
          args: { subject: 'Rollback draft on operation failure' },
        },
        {
          saveDraft: async (draft) => draft,
          deleteDraft: async (id) => {
            deleted.push(id);
          },
          recordOperation: async () => {
            throw new Error('record failed');
          },
        },
      );
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(deleted).toEqual(['draft_rollback']);
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
    const original = await withToolContext(() => getMessage(account, messageId));
    expect(original).toBeTruthy();
    const quoted = buildForwardMessagePayload(original!, { body: 'FYI' });
    expect(quoted.subject).toBe('Fwd: Original');
    expect(quoted.body).toContain('FYI');
    expect(quoted.body).toContain('Subject: Original');
    expect(quoted.body).toContain('Please review this doc.');
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
