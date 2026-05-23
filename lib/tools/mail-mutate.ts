import { z } from 'zod';
import { runGogJson } from '../gog/pool';
import { SMART_CATEGORY_IDS } from '../mail/smart-categories';
import { getThreadMessages } from '../store/messages';
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

async function gmailMutate(args: string[]): Promise<any> {
  return await runGogJson<any>(args, { timeoutMs: 60_000 });
}

export const archiveThread = defineTool({
  name: 'archive_thread',
  description: 'Archive a thread (remove the INBOX label).',
  category: 'mail',
  mutating: true,
  input: ThreadMutate,
  output: z.object({ ok: z.boolean() }),
  async handler({ account, threadId }) {
    await gmailMutate([
      '--account',
      account,
      '--json',
      'gmail',
      'thread',
      'modify',
      threadId,
      '--remove',
      'INBOX',
      '--no-input',
    ]);
    return { ok: true };
  },
});

export const trashThread = defineTool({
  name: 'trash_thread',
  description: 'Move a thread to Trash.',
  category: 'mail',
  mutating: true,
  input: ThreadMutate,
  output: z.object({ ok: z.boolean() }),
  async handler({ account, threadId }) {
    await gmailMutate([
      '--account',
      account,
      '--json',
      'gmail',
      'thread',
      'modify',
      threadId,
      '--add',
      'TRASH',
      '--remove',
      'INBOX',
      '--no-input',
    ]);
    return { ok: true };
  },
});

export const restoreFromTrash = defineTool({
  name: 'restore_from_trash',
  description: 'Restore a thread from Trash.',
  category: 'mail',
  mutating: true,
  input: ThreadMutate,
  output: z.object({ ok: z.boolean() }),
  async handler({ account, threadId }) {
    await gmailMutate([
      '--account',
      account,
      '--json',
      'gmail',
      'thread',
      'modify',
      threadId,
      '--remove',
      'TRASH',
      '--add',
      'INBOX',
      '--no-input',
    ]);
    return { ok: true };
  },
});

export const markRead = defineTool({
  name: 'mark_read',
  description: 'Mark a message as read (remove UNREAD label).',
  category: 'mail',
  mutating: true,
  input: BasicMutate,
  output: z.object({ ok: z.boolean() }),
  async handler({ account, messageId }) {
    await gmailMutate(['--account', account, '--json', 'gmail', 'mark-read', messageId, '--no-input']);
    return { ok: true };
  },
});

export const markUnread = defineTool({
  name: 'mark_unread',
  description: 'Mark a message as unread (add UNREAD label).',
  category: 'mail',
  mutating: true,
  input: BasicMutate,
  output: z.object({ ok: z.boolean() }),
  async handler({ account, messageId }) {
    await gmailMutate(['--account', account, '--json', 'gmail', 'unread', messageId, '--no-input']);
    return { ok: true };
  },
});

export const markThreadRead = defineTool({
  name: 'mark_thread_read',
  description: 'Mark every unread message in a thread as read and update the local cached thread state.',
  category: 'mail',
  mutating: true,
  input: z.object({
    account: z.string(),
    threadId: z.string(),
    messageIds: z.array(z.string()).optional(),
  }),
  output: z.object({ ok: z.boolean(), marked: z.number() }),
  async handler({ account, threadId, messageIds }) {
    const cachedMessages = await getThreadMessages(account, threadId).catch(() => []);
    const ids = [
      ...new Set(
        (messageIds?.length
          ? messageIds
          : cachedMessages.filter((m) => m.labels?.includes('UNREAD')).map((m) => m._id)
        ).filter(Boolean),
      ),
    ];
    if (ids.length) {
      await Promise.allSettled(
        ids.map((id) =>
          gmailMutate(['--account', account, '--json', 'gmail', 'mark-read', id, '--no-input']),
        ),
      );
    } else {
      await gmailMutate([
        '--account',
        account,
        '--json',
        'gmail',
        'thread',
        'modify',
        threadId,
        '--remove',
        'UNREAD',
        '--no-input',
      ]).catch(() => undefined);
    }
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
    return { ok: true, marked: ids.length };
  },
});

export const starMessage = defineTool({
  name: 'star',
  description: 'Star a message (add STARRED label).',
  category: 'mail',
  mutating: true,
  input: BasicMutate,
  output: z.object({ ok: z.boolean() }),
  async handler({ account, messageId }) {
    await gmailMutate([
      '--account',
      account,
      '--json',
      'gmail',
      'messages',
      'modify',
      messageId,
      '--add',
      'STARRED',
      '--no-input',
    ]);
    return { ok: true };
  },
});

export const unstarMessage = defineTool({
  name: 'unstar',
  description: 'Remove the STARRED label from a message.',
  category: 'mail',
  mutating: true,
  input: BasicMutate,
  output: z.object({ ok: z.boolean() }),
  async handler({ account, messageId }) {
    await gmailMutate([
      '--account',
      account,
      '--json',
      'gmail',
      'messages',
      'modify',
      messageId,
      '--remove',
      'STARRED',
      '--no-input',
    ]);
    return { ok: true };
  },
});

export const addLabel = defineTool({
  name: 'add_label',
  description: 'Add a label to a message.',
  category: 'mail',
  mutating: true,
  input: BasicMutate.extend({ label: z.string() }),
  output: z.object({ ok: z.boolean() }),
  async handler({ account, messageId, label }) {
    await gmailMutate([
      '--account',
      account,
      '--json',
      'gmail',
      'messages',
      'modify',
      messageId,
      '--add',
      label,
      '--no-input',
    ]);
    return { ok: true };
  },
});

export const removeLabel = defineTool({
  name: 'remove_label',
  description: 'Remove a label from a message.',
  category: 'mail',
  mutating: true,
  input: BasicMutate.extend({ label: z.string() }),
  output: z.object({ ok: z.boolean() }),
  async handler({ account, messageId, label }) {
    await gmailMutate([
      '--account',
      account,
      '--json',
      'gmail',
      'messages',
      'modify',
      messageId,
      '--remove',
      label,
      '--no-input',
    ]);
    return { ok: true };
  },
});

export const createLabel = defineTool({
  name: 'create_label',
  description: 'Create a new Gmail label.',
  category: 'mail',
  mutating: true,
  input: z.object({ account: z.string(), name: z.string() }),
  output: z.object({ ok: z.boolean(), id: z.string().optional() }),
  async handler({ account, name }) {
    const raw = await gmailMutate([
      '--account',
      account,
      '--json',
      'gmail',
      'labels',
      'create',
      name,
      '--no-input',
    ]);
    return { ok: true, id: raw?.id || raw?.label?.id };
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
  async handler({ account, items }) {
    const uniqueLabels = [
      ...new Set(items.flatMap((item) => item.labels).filter((label) => label.startsWith('MailOS/'))),
    ];
    await Promise.allSettled(
      uniqueLabels.map((label) =>
        gmailMutate(['--account', account, '--json', 'gmail', 'labels', 'create', label, '--no-input']),
      ),
    );

    let applied = 0;
    for (const item of items) {
      const labels = [...new Set(item.labels)];
      const targetId = item.messageId || item.threadId;
      const command = item.messageId ? ['messages', 'modify', targetId] : ['thread', 'modify', targetId];
      for (const label of labels) {
        await gmailMutate([
          '--account',
          account,
          '--json',
          'gmail',
          ...command,
          '--add',
          label,
          '--no-input',
        ]);
        applied += 1;
      }
      const existing = await getThread(account, item.threadId).catch(() => null);
      const labelsApplied = [...new Set([...(existing?.gmailLabelSync?.labelsApplied || []), ...labels])];
      await setThreadGmailLabelSync(account, item.threadId, {
        labelsApplied,
        pendingLabels: [],
        lastAppliedAt: Date.now(),
      }).catch(() => undefined);
    }
    return { ok: true, applied };
  },
});

export const setSmartCategoryTool = defineTool({
  name: 'set_smart_category',
  description: 'Locally override a thread smart category without mutating Gmail labels.',
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
  async handler({ account, threadId }) {
    await gmailMutate([
      '--account',
      account,
      '--json',
      'gmail',
      'thread',
      'modify',
      threadId,
      '--add',
      'MUTE',
      '--no-input',
    ]);
    return { ok: true };
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
    // Optional: also label in Gmail so the user can see it in the web UI.
    try {
      await gmailMutate([
        '--account',
        account,
        '--json',
        'gmail',
        'messages',
        'modify',
        messageId,
        '--add',
        'MailOS/Snoozed',
        '--remove',
        'INBOX',
        '--no-input',
      ]);
    } catch {}
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
    try {
      await gmailMutate([
        '--account',
        account,
        '--json',
        'gmail',
        'messages',
        'modify',
        messageId,
        '--remove',
        'MailOS/Snoozed',
        '--add',
        'INBOX',
        '--no-input',
      ]);
    } catch {}
    return { ok: true };
  },
});
