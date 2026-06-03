import { z } from 'zod';
import { buildReplyArgs, buildSendArgs } from '../compose/gog-args';
import { runGogJson } from '../gog/pool';
import { emailFromHeader } from '../shared/format';
import type { Draft } from '../shared/types';
import {
  deleteDraft as deleteDraftRecord,
  getDraft,
  listDrafts,
  saveDraft as saveDraftRecord,
} from '../store/drafts';
import { getMessage as getMessageRecord, getThreadMessages } from '../store/messages';
import { defineTool } from './registry';

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

async function resolveReplyTarget(account: string, messageId?: string, threadId?: string) {
  const anchor =
    (messageId ? await getMessageRecord(account, messageId).catch(() => null) : null) ||
    (threadId
      ? (await getThreadMessages(account, threadId).catch(() => [])).sort(
          (a, b) => Number(b.date || 0) - Number(a.date || 0),
        )[0]
      : null);
  if (!anchor) {
    throw new Error('Cannot reply — original message is not in the local cache. Open the thread first.');
  }
  const to = emailFromHeader(anchor.from) || anchor.from;
  if (!to) throw new Error('Cannot reply — original sender is missing.');
  return {
    to,
    subject: anchor.subject?.startsWith('Re:') ? anchor.subject : `Re: ${anchor.subject || '(no subject)'}`,
  };
}

export const sendMessage = defineTool({
  name: 'send_message',
  description: 'Send a brand-new email.',
  category: 'compose',
  mutating: true,
  input: SendBase,
  output: z.object({ ok: z.boolean() }),
  async handler({ account, to, cc, bcc, subject, body, html, from }) {
    await gmailSend(buildSendArgs({ account, to, cc, bcc, subject, body, html, from }));
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
    html: z.string().optional(),
    from: z.string().optional(),
  }),
  output: z.object({ ok: z.boolean() }),
  async handler({ account, messageId, threadId, body, html, from }) {
    const target = await resolveReplyTarget(account, messageId, threadId);
    await gmailSend(
      buildReplyArgs({
        account,
        messageId,
        threadId,
        to: target.to,
        subject: target.subject,
        body,
        html,
        from,
      }),
    );
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
    html: z.string().optional(),
    from: z.string().optional(),
  }),
  output: z.object({ ok: z.boolean() }),
  async handler({ account, messageId, threadId, body, html, from }) {
    await gmailSend(buildReplyArgs({ account, messageId, threadId, body, html, from, replyAll: true }));
    return { ok: true };
  },
});

// gog does not have a native --forward-message-id flag, so we synthesize the
// quoted-body forward ourselves: fetch the original message (from local cache),
// prepend a "Forwarded message" header block, and send as a fresh email.
// v1 limitation: original attachments are *not* re-carried; treat that as a
// follow-up (the gog `gmail attachment` command can re-download them).
export const forwardMessage = defineTool({
  name: 'forward',
  description:
    'Forward a message to one or more recipients. Synthesizes a quoted body from the original message; original attachments are not re-carried.',
  category: 'compose',
  mutating: true,
  input: z.object({
    account: z.string(),
    messageId: z.string(),
    to: z.string(),
    cc: z.string().optional(),
    bcc: z.string().optional(),
    body: z.string().optional(),
    html: z.string().optional(),
    from: z.string().optional(),
  }),
  output: z.object({ ok: z.boolean() }),
  async handler({ account, messageId, to, cc, bcc, body, html, from }) {
    const original = await getMessageRecord(account, messageId);
    if (!original)
      throw new Error('Cannot forward — original message not in local cache. Open the thread first.');
    const fwdSubject = original.subject?.startsWith('Fwd:')
      ? original.subject
      : `Fwd: ${original.subject || '(no subject)'}`;
    const headerBlock = [
      '---------- Forwarded message ----------',
      `From: ${original.from}`,
      `Date: ${new Date(original.date).toISOString()}`,
      `Subject: ${original.subject || ''}`,
      `To: ${original.to || ''}`,
      original.cc ? `Cc: ${original.cc}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const quotedText = [body || '', '', headerBlock, '', original.textBody || ''].join('\n');
    const quotedHtml = html
      ? [
          html,
          '<br/><br/>',
          `<div style="border-left:2px solid currentColor;padding-left:.6em;opacity:.72">`,
          `<div>---------- Forwarded message ----------</div>`,
          `<div>From: ${escapeHtml(original.from)}</div>`,
          `<div>Date: ${new Date(original.date).toISOString()}</div>`,
          `<div>Subject: ${escapeHtml(original.subject || '')}</div>`,
          `<div>To: ${escapeHtml(original.to || '')}</div>`,
          original.cc ? `<div>Cc: ${escapeHtml(original.cc)}</div>` : '',
          `</div>`,
          original.htmlBody || `<pre>${escapeHtml(original.textBody || '')}</pre>`,
        ].join('')
      : undefined;
    await gmailSend(
      buildSendArgs({
        account,
        to,
        cc,
        bcc,
        subject: fwdSubject,
        body: quotedText,
        html: quotedHtml,
        from,
      }),
    );
    return { ok: true };
  },
});

function escapeHtml(s: string): string {
  return String(s || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

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
