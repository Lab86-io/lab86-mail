import { z } from 'zod';
import { defineTool } from './registry';
import { runGogJson } from '../gog/pool';
import { snoozeMessage, unsnoozeByMessage } from '../store/snooze';

const BasicMutate = z.object({
  account: z.string(),
  messageId: z.string(),
});

const ThreadMutate = z.object({
  account: z.string(),
  threadId: z.string(),
});

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
      '--account', account, '--json', 'gmail', 'thread', 'modify', threadId,
      '--remove', 'INBOX', '--no-input',
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
      '--account', account, '--json', 'gmail', 'thread', 'modify', threadId,
      '--add', 'TRASH', '--remove', 'INBOX', '--no-input',
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
      '--account', account, '--json', 'gmail', 'thread', 'modify', threadId,
      '--remove', 'TRASH', '--add', 'INBOX', '--no-input',
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

export const starMessage = defineTool({
  name: 'star',
  description: 'Star a message (add STARRED label).',
  category: 'mail',
  mutating: true,
  input: BasicMutate,
  output: z.object({ ok: z.boolean() }),
  async handler({ account, messageId }) {
    await gmailMutate([
      '--account', account, '--json', 'gmail', 'messages', 'modify', messageId, '--add', 'STARRED', '--no-input',
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
      '--account', account, '--json', 'gmail', 'messages', 'modify', messageId, '--remove', 'STARRED', '--no-input',
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
      '--account', account, '--json', 'gmail', 'messages', 'modify', messageId, '--add', label, '--no-input',
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
      '--account', account, '--json', 'gmail', 'messages', 'modify', messageId, '--remove', label, '--no-input',
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
    const raw = await gmailMutate(['--account', account, '--json', 'gmail', 'labels', 'create', name, '--no-input']);
    return { ok: true, id: raw?.id || raw?.label?.id };
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
      '--account', account, '--json', 'gmail', 'thread', 'modify', threadId, '--add', 'MUTE', '--no-input',
    ]);
    return { ok: true };
  },
});

export const snoozeThreadTool = defineTool({
  name: 'snooze_thread',
  description: 'Snooze a message until a future timestamp. Adds a MailOS/Snoozed label and records due time locally.',
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
        '--account', account, '--json', 'gmail', 'messages', 'modify', messageId,
        '--add', 'MailOS/Snoozed', '--remove', 'INBOX', '--no-input',
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
        '--account', account, '--json', 'gmail', 'messages', 'modify', messageId,
        '--remove', 'MailOS/Snoozed', '--add', 'INBOX', '--no-input',
      ]);
    } catch {}
    return { ok: true };
  },
});
