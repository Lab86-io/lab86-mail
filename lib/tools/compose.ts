import { z } from 'zod';
import { defineTool } from './registry';
import { runGogJson } from '../gog/pool';
import { saveDraft as saveDraftRecord, getDraft, deleteDraft as deleteDraftRecord, listDrafts } from '../store/drafts';
import type { Draft } from '../shared/types';

const SendBase = z.object({
  account: z.string(),
  to: z.string(),
  cc: z.string().optional(),
  bcc: z.string().optional(),
  subject: z.string(),
  body: z.string(),
  html: z.string().optional(),
  from: z.string().optional(),
});

async function gmailSend(args: string[]): Promise<any> {
  return await runGogJson<any>(args, { timeoutMs: 90_000 });
}

export const sendMessage = defineTool({
  name: 'send_message',
  description: 'Send a brand-new email.',
  category: 'compose',
  mutating: true,
  input: SendBase,
  output: z.object({ ok: z.boolean() }),
  async handler({ account, to, cc, bcc, subject, body, from }) {
    const args = [
      '--account', account, '--json', 'gmail', 'send',
      '--to', to, '--subject', subject, '--body', body, '--no-input',
    ];
    if (cc) args.push('--cc', cc);
    if (bcc) args.push('--bcc', bcc);
    if (from) args.push('--from', from);
    await gmailSend(args);
    return { ok: true };
  },
});

export const replyMessage = defineTool({
  name: 'reply',
  description: 'Reply to a single message (to its sender).',
  category: 'compose',
  mutating: true,
  input: z.object({
    account: z.string(),
    messageId: z.string(),
    threadId: z.string().optional(),
    body: z.string(),
    from: z.string().optional(),
  }),
  output: z.object({ ok: z.boolean() }),
  async handler({ account, messageId, threadId, body, from }) {
    const args = [
      '--account', account, '--json', 'gmail', 'send',
      '--reply-to-message-id', messageId, '--body', body, '--no-input',
    ];
    if (threadId) args.push('--thread-id', threadId);
    if (from) args.push('--from', from);
    await gmailSend(args);
    return { ok: true };
  },
});

export const replyAllMessage = defineTool({
  name: 'reply_all',
  description: 'Reply-all to a message (everyone on To: + Cc:).',
  category: 'compose',
  mutating: true,
  input: z.object({
    account: z.string(),
    messageId: z.string(),
    threadId: z.string().optional(),
    body: z.string(),
    from: z.string().optional(),
  }),
  output: z.object({ ok: z.boolean() }),
  async handler({ account, messageId, threadId, body, from }) {
    const args = [
      '--account', account, '--json', 'gmail', 'send',
      '--reply-to-message-id', messageId, '--reply-all', '--body', body, '--no-input',
    ];
    if (threadId) args.push('--thread-id', threadId);
    if (from) args.push('--from', from);
    await gmailSend(args);
    return { ok: true };
  },
});

export const forwardMessage = defineTool({
  name: 'forward',
  description: 'Forward a message to one or more recipients.',
  category: 'compose',
  mutating: true,
  input: z.object({
    account: z.string(),
    messageId: z.string(),
    to: z.string(),
    body: z.string().optional(),
    from: z.string().optional(),
  }),
  output: z.object({ ok: z.boolean() }),
  async handler({ account, messageId, to, body, from }) {
    const args = [
      '--account', account, '--json', 'gmail', 'send',
      '--forward-message-id', messageId, '--to', to, '--no-input',
    ];
    if (body) args.push('--body', body);
    if (from) args.push('--from', from);
    await gmailSend(args);
    return { ok: true };
  },
});

export const saveDraftTool = defineTool({
  name: 'save_draft',
  description: 'Persist a draft locally (not yet uploaded to Gmail).',
  category: 'compose',
  mutating: true,
  input: z.object({
    account: z.string(),
    threadId: z.string().optional(),
    inReplyToMessageId: z.string().optional(),
    to: z.string(),
    cc: z.string().optional(),
    bcc: z.string().optional(),
    subject: z.string(),
    body: z.string(),
    html: z.string().optional(),
    scheduledFor: z.number().optional(),
  }),
  output: z.object({ ok: z.boolean(), draft: z.any() }),
  async handler(args) {
    const doc: Draft = { ...args, updatedAt: Date.now() };
    const saved = await saveDraftRecord(doc);
    return { ok: true, draft: saved };
  },
});

export const updateDraft = defineTool({
  name: 'update_draft',
  description: 'Update an existing local draft by id.',
  category: 'compose',
  mutating: true,
  input: z.object({
    id: z.string(),
    patch: z.object({
      to: z.string().optional(),
      cc: z.string().optional(),
      bcc: z.string().optional(),
      subject: z.string().optional(),
      body: z.string().optional(),
      html: z.string().optional(),
      scheduledFor: z.number().optional(),
    }),
  }),
  output: z.object({ ok: z.boolean() }),
  async handler({ id, patch }) {
    const draft = await getDraft(id);
    if (!draft) throw new Error('Draft not found');
    Object.assign(draft, patch);
    await saveDraftRecord(draft);
    return { ok: true };
  },
});

export const deleteDraftTool = defineTool({
  name: 'delete_draft',
  description: 'Delete a local draft.',
  category: 'compose',
  mutating: true,
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.boolean() }),
  async handler({ id }) {
    await deleteDraftRecord(id);
    return { ok: true };
  },
});

export const listDraftsTool = defineTool({
  name: 'list_drafts',
  description: 'List local drafts for an account.',
  category: 'compose',
  mutating: false,
  input: z.object({ account: z.string() }),
  output: z.object({ drafts: z.array(z.any()) }),
  async handler({ account }) {
    return { drafts: await listDrafts(account) };
  },
});

export const scheduleSend = defineTool({
  name: 'schedule_send',
  description:
    'Schedule a send for a future time by persisting it as a draft with scheduledFor. A worker polls and sends when due.',
  category: 'compose',
  mutating: true,
  input: SendBase.extend({ scheduledFor: z.number().describe('Epoch ms when to send') }),
  output: z.object({ ok: z.boolean(), draftId: z.string().optional() }),
  async handler(args) {
    const draft: Draft = { ...args, updatedAt: Date.now() };
    const saved = await saveDraftRecord(draft);
    return { ok: true, draftId: saved._id };
  },
});

export const cancelScheduled = defineTool({
  name: 'cancel_scheduled',
  description: 'Cancel a scheduled send by draft id.',
  category: 'compose',
  mutating: true,
  input: z.object({ draftId: z.string() }),
  output: z.object({ ok: z.boolean() }),
  async handler({ draftId }) {
    await deleteDraftRecord(draftId);
    return { ok: true };
  },
});

export const undoSend = defineTool({
  name: 'undo_send',
  description:
    'Cancel a recently-queued send (operates on the in-memory pending queue handled by /api/agent/send).',
  category: 'compose',
  mutating: true,
  input: z.object({ pendingId: z.string() }),
  output: z.object({ ok: z.boolean(), undone: z.boolean() }),
  async handler({ pendingId }) {
    // Lazy-load the pending queue from a shared module to avoid circular imports.
    const { cancelPending } = await import('../send/pending');
    const undone = cancelPending(pendingId);
    return { ok: true, undone };
  },
});
