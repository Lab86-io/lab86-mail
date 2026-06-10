import { z } from 'zod';
import { SMART_CATEGORY_IDS } from '../mail/smart-categories';
import {
  createNylasFolder,
  updateNylasMessage,
  updateNylasMessageFolders,
  updateNylasMessageFoldersWithRetry,
  updateNylasThread,
  updateNylasThreadFolders,
  updateNylasThreadFoldersWithRetry,
} from '../nylas/provider';
import { snoozeMessage, unsnoozeByMessage } from '../store/snooze';
import {
  getThread,
  setThreadGmailLabelSync,
  setThreadReadState,
  setThreadSmartCategory,
  upsertThread,
} from '../store/threads';
import { defineTool } from './registry';

const BasicMutate = z.object({
  account: z.string(),
  messageId: z.string(),
});

const ThreadMutate = z.object({
  account: z.string(),
  threadId: z.string(),
});

const SmartCategorySchema = z.enum(SMART_CATEGORY_IDS);

export const archiveThread = defineTool({
  name: 'archive_thread',
  description: 'Archive a thread.',
  category: 'mail',
  mutating: true,
  input: ThreadMutate,
  output: z.object({ ok: z.boolean() }),
  async handler({ account, threadId }, ctx) {
    return await requireNylasResult(
      updateNylasThread({
        userId: ctx.userId,
        account,
        threadId,
        folders: [],
      }),
    );
  },
});

export const trashThread = defineTool({
  name: 'trash_thread',
  description: 'Move a thread to Trash.',
  category: 'mail',
  mutating: true,
  input: ThreadMutate,
  output: z.object({ ok: z.boolean() }),
  async handler({ account, threadId }, ctx) {
    return await requireNylasResult(
      updateNylasThread({
        userId: ctx.userId,
        account,
        threadId,
        folders: ['TRASH'],
      }),
    );
  },
});

export const restoreFromTrash = defineTool({
  name: 'restore_from_trash',
  description: 'Restore a thread from Trash.',
  category: 'mail',
  mutating: true,
  input: ThreadMutate,
  output: z.object({ ok: z.boolean() }),
  async handler({ account, threadId }, ctx) {
    return await requireNylasResult(
      updateNylasThread({
        userId: ctx.userId,
        account,
        threadId,
        folders: ['INBOX'],
      }),
    );
  },
});

export const markRead = defineTool({
  name: 'mark_read',
  description: 'Mark a message as read.',
  category: 'mail',
  mutating: true,
  input: BasicMutate,
  output: z.object({ ok: z.boolean() }),
  async handler({ account, messageId }, ctx) {
    return await requireNylasResult(
      updateNylasMessage({
        userId: ctx.userId,
        account,
        messageId,
        unread: false,
      }),
    );
  },
});

export const markUnread = defineTool({
  name: 'mark_unread',
  description: 'Mark a message as unread.',
  category: 'mail',
  mutating: true,
  input: BasicMutate,
  output: z.object({ ok: z.boolean() }),
  async handler({ account, messageId }, ctx) {
    return await requireNylasResult(
      updateNylasMessage({
        userId: ctx.userId,
        account,
        messageId,
        unread: true,
      }),
    );
  },
});

export const markThreadRead = defineTool({
  name: 'mark_thread_read',
  description: 'Mark every unread message in a thread as read and update the cached thread state.',
  category: 'mail',
  mutating: true,
  input: z.object({
    account: z.string(),
    threadId: z.string(),
    messageIds: z.array(z.string()).optional(),
  }),
  output: z.object({ ok: z.boolean(), marked: z.number() }),
  async handler({ account, threadId, messageIds }, ctx) {
    await requireNylasResult(
      updateNylasThread({
        userId: ctx.userId,
        account,
        threadId,
        unread: false,
      }),
    );
    const existing = await getThread(account, threadId).catch(() => null);
    await upsertThread(account, {
      _id: threadId,
      unread: false,
      labels: (existing?.labels || []).filter((label) => label !== 'UNREAD'),
      readState: { ...(existing?.readState || {}), openedAt: Date.now(), lastMarkedReadAt: Date.now() },
    }).catch(() => undefined);
    await setThreadReadState(account, threadId, {
      ...(existing?.readState || {}),
      openedAt: Date.now(),
      lastMarkedReadAt: Date.now(),
    }).catch(() => undefined);
    return { ok: true, marked: messageIds?.length || 0 };
  },
});

export const starMessage = defineTool({
  name: 'star',
  description: 'Star a message.',
  category: 'mail',
  mutating: true,
  input: BasicMutate,
  output: z.object({ ok: z.boolean() }),
  async handler({ account, messageId }, ctx) {
    return await requireNylasResult(
      updateNylasMessage({
        userId: ctx.userId,
        account,
        messageId,
        starred: true,
      }),
    );
  },
});

export const unstarMessage = defineTool({
  name: 'unstar',
  description: 'Remove the starred state from a message.',
  category: 'mail',
  mutating: true,
  input: BasicMutate,
  output: z.object({ ok: z.boolean() }),
  async handler({ account, messageId }, ctx) {
    return await requireNylasResult(
      updateNylasMessage({
        userId: ctx.userId,
        account,
        messageId,
        starred: false,
      }),
    );
  },
});

export const addLabel = defineTool({
  name: 'add_label',
  description: 'Add a folder/label to a message.',
  category: 'mail',
  mutating: true,
  input: BasicMutate.extend({ label: z.string() }),
  output: z.object({ ok: z.boolean() }),
  async handler({ account, messageId, label }, ctx) {
    return await requireNylasResult(
      updateNylasMessageFolders({
        userId: ctx.userId,
        account,
        messageId,
        add: [label],
        createMissing: true,
      }),
    );
  },
});

export const removeLabel = defineTool({
  name: 'remove_label',
  description: 'Remove a folder/label from a message.',
  category: 'mail',
  mutating: true,
  input: BasicMutate.extend({ label: z.string() }),
  output: z.object({ ok: z.boolean() }),
  async handler({ account, messageId, label }, ctx) {
    return await requireNylasResult(
      updateNylasMessageFolders({
        userId: ctx.userId,
        account,
        messageId,
        remove: [label],
      }),
    );
  },
});

export const createLabel = defineTool({
  name: 'create_label',
  description: 'Create a new provider folder/label.',
  category: 'mail',
  mutating: true,
  input: z.object({ account: z.string(), name: z.string() }),
  output: z.object({ ok: z.boolean(), id: z.string().optional() }),
  async handler({ account, name }, ctx) {
    const created = await requireNylasResult(
      createNylasFolder({
        userId: ctx.userId,
        account,
        name,
      }),
    );
    return { ok: true, id: created.id };
  },
});

export const applySmartLabels = defineTool({
  name: 'apply_smart_labels',
  description: 'Create missing MailOS labels and apply reviewed smart labels to messages or threads.',
  category: 'mail',
  mutating: true,
  input: z.object({
    account: z.string(),
    items: z
      .array(
        z.object({
          threadId: z.string(),
          messageId: z.string().optional(),
          labels: z.array(z.string()).min(1),
        }),
      )
      .min(1)
      .max(80),
  }),
  output: z.object({ ok: z.boolean(), applied: z.number() }),
  async handler({ account, items }, ctx) {
    const uniqueLabels = [
      ...new Set(items.flatMap((item) => item.labels).filter((label) => label.startsWith('MailOS/'))),
    ];
    for (const label of uniqueLabels) {
      await requireNylasResult(createNylasFolder({ userId: ctx.userId, account, name: label }));
      await delay(250);
    }

    let applied = 0;
    for (const item of items) {
      const labels = [...new Set(item.labels)];
      if (item.messageId) {
        await requireNylasResult(
          updateNylasMessageFoldersWithRetry({
            userId: ctx.userId,
            account,
            messageId: item.messageId,
            add: labels,
            createMissing: true,
            retries: 5,
          }),
        );
      } else {
        await requireNylasResult(
          updateNylasThreadFoldersWithRetry({
            userId: ctx.userId,
            account,
            threadId: item.threadId,
            add: labels,
            createMissing: true,
            retries: 5,
          }),
        );
      }
      applied += labels.length;

      const existing = await getThread(account, item.threadId).catch(() => null);
      const labelsApplied = [...new Set([...(existing?.gmailLabelSync?.labelsApplied || []), ...labels])];
      await setThreadGmailLabelSync(account, item.threadId, {
        labelsApplied,
        pendingLabels: [],
        lastAppliedAt: Date.now(),
      }).catch(() => undefined);
      await delay(500);
    }
    return { ok: true, applied };
  },
});

export const setSmartCategoryTool = defineTool({
  name: 'set_smart_category',
  description: 'Locally override a thread smart category without mutating provider labels.',
  category: 'mail',
  mutating: true,
  input: z.object({
    account: z.string(),
    threadId: z.string(),
    category: SmartCategorySchema,
    reason: z.string().optional(),
  }),
  output: z.object({ ok: z.boolean() }),
  async handler({ account, threadId, category, reason }) {
    const existing = await getThread(account, threadId).catch(() => null);
    await setThreadSmartCategory(account, threadId, {
      primary: category,
      secondary: [],
      confidence: 1,
      reason: reason || 'Set by user correction.',
      needsAttention: category === 'review' || category === 'main',
      suggestedAction: category === 'review' ? 'read' : 'none',
      isHumanLike: existing?.smartCategory?.isHumanLike || false,
      isAutomated: existing?.smartCategory?.isAutomated || false,
      allowNoReplyInMain: existing?.smartCategory?.allowNoReplyInMain || false,
      signals: ['user_correction'],
      classifiedAt: Date.now(),
      model: 'user',
    }).catch(() => undefined);
    return { ok: true };
  },
});

export const muteThread = defineTool({
  name: 'mute_thread',
  description: 'Mute a thread so future replies bypass the inbox.',
  category: 'mail',
  mutating: true,
  input: ThreadMutate,
  output: z.object({ ok: z.boolean() }),
  async handler({ account, threadId }, ctx) {
    return await requireNylasResult(
      updateNylasThreadFolders({
        userId: ctx.userId,
        account,
        threadId,
        add: ['MUTE'],
      }),
    );
  },
});

export const snoozeThreadTool = defineTool({
  name: 'snooze_thread',
  description:
    'Snooze a message until a future timestamp. Adds a MailOS/Snoozed label and records due time locally.',
  category: 'mail',
  mutating: true,
  input: z.object({
    account: z.string(),
    messageId: z.string(),
    threadId: z.string(),
    untilTs: z.number().describe('Epoch ms when the message should resurface'),
  }),
  output: z.object({ ok: z.boolean(), untilIso: z.string() }),
  async handler({ account, messageId, threadId, untilTs }) {
    await snoozeMessage(account, messageId, threadId, untilTs);
    return { ok: true, untilIso: new Date(untilTs).toISOString() };
  },
});

export const unsnoozeThreadTool = defineTool({
  name: 'unsnooze_thread',
  description: 'Cancel a snooze for a message.',
  category: 'mail',
  mutating: true,
  input: BasicMutate,
  output: z.object({ ok: z.boolean() }),
  async handler({ account, messageId }) {
    await unsnoozeByMessage(account, messageId);
    return { ok: true };
  },
});

async function requireNylasResult<T>(value: Promise<T | null>): Promise<T> {
  const result = await value;
  if (!result) throw new Error('Connected Nylas account not found.');
  return result;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
