import { z } from 'zod';
import { listNylasScheduledMessages, sendNylasMessage, stopNylasScheduledMessage } from '../nylas/provider';
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

async function sendWithNylas(args: Parameters<typeof sendNylasMessage>[0]) {
  const sent = await sendNylasMessage(args);
  if (!sent) throw new Error('Connect this mailbox with Nylas before sending.');
  return sent;
}

async function resolveReplyAnchor(account: string, messageId?: string, threadId?: string) {
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
  return anchor;
}

async function resolveReplyTarget(account: string, messageId?: string, threadId?: string) {
  const anchor = await resolveReplyAnchor(account, messageId, threadId);
  const to = emailFromHeader(anchor.from) || anchor.from;
  if (!to) throw new Error('Cannot reply — original sender is missing.');
  return {
    to,
    subject: anchor.subject?.startsWith('Re:') ? anchor.subject : `Re: ${anchor.subject || '(no subject)'}`,
  };
}

async function resolveReplyAllTarget(account: string, messageId?: string, threadId?: string) {
  const anchor = await resolveReplyAnchor(account, messageId, threadId);
  const self = account.toLowerCase();
  const recipients = new Set<string>();
  for (const field of [anchor.from, anchor.to, anchor.cc]) {
    for (const item of String(field || '').split(/[,;]/)) {
      const email = emailFromHeader(item) || item.trim();
      if (!email || email.toLowerCase() === self) continue;
      recipients.add(email);
    }
  }
  return {
    to: [...recipients].join(', '),
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
  async handler({ account, to, cc, bcc, subject, body, html }, ctx) {
    await sendWithNylas({ userId: ctx.userId, account, to, cc, bcc, subject, body, html });
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
  async handler({ account, messageId, threadId, body, html }, ctx) {
    const target = await resolveReplyTarget(account, messageId, threadId);
    await sendWithNylas({
      userId: ctx.userId,
      account,
      to: target.to,
      subject: target.subject,
      body,
      html,
      replyToMessageId: messageId,
    });
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
  async handler({ account, messageId, threadId, body, html }, ctx) {
    const target = await resolveReplyAllTarget(account, messageId, threadId);
    if (!target.to) throw new Error('Cannot reply-all — no recipients are available.');
    await sendWithNylas({
      userId: ctx.userId,
      account,
      to: target.to,
      subject: target.subject,
      body,
      html,
      replyToMessageId: messageId,
    });
    return { ok: true };
  },
});

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
  async handler({ account, messageId, to, cc, bcc, body, html }, ctx) {
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
    await sendWithNylas({
      userId: ctx.userId,
      account,
      to,
      cc,
      bcc,
      subject: fwdSubject,
      body: quotedText,
      html: quotedHtml,
    });
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
    'Schedule an email to send at a future time (provider-side via Nylas send_at). Returns a scheduleId usable with cancel_scheduled.',
  category: 'compose',
  mutating: true,
  input: SendBase.extend({ scheduledFor: z.number().describe('Epoch ms when to send') }),
  output: z.object({ ok: z.boolean(), scheduleId: z.string().optional(), messageId: z.string().optional() }),
  async handler({ account, to, cc, bcc, subject, body, html, scheduledFor }, ctx) {
    if (scheduledFor < Date.now() + 60_000) {
      throw new Error('scheduledFor must be at least a minute in the future.');
    }
    const sent = await sendWithNylas({
      userId: ctx.userId,
      account,
      to,
      cc,
      bcc,
      subject,
      body,
      html,
      sendAt: scheduledFor,
    });
    return { ok: true, scheduleId: (sent as any).scheduleId, messageId: sent._id };
  },
});

export const cancelScheduled = defineTool({
  name: 'cancel_scheduled',
  description: 'Cancel a scheduled send by its Nylas scheduleId (see list_scheduled / schedule_send).',
  category: 'compose',
  mutating: true,
  input: z.object({ account: z.string(), scheduleId: z.string() }),
  output: z.object({ ok: z.boolean() }),
  async handler({ account, scheduleId }, ctx) {
    const result = await stopNylasScheduledMessage({ userId: ctx.userId, account, scheduleId });
    if (!result) throw new Error('Connect this mailbox with Nylas before cancelling scheduled sends.');
    return { ok: true };
  },
});

export const listScheduled = defineTool({
  name: 'list_scheduled',
  description: 'List emails scheduled to send later on this account.',
  category: 'compose',
  mutating: false,
  input: z.object({ account: z.string() }),
  output: z.object({ scheduled: z.array(z.any()) }),
  async handler({ account }, ctx) {
    const scheduled = await listNylasScheduledMessages({ userId: ctx.userId, account });
    return { scheduled: Array.isArray(scheduled) ? scheduled : (scheduled?.schedules ?? []) };
  },
});

export const undoSend = defineTool({
  name: 'undo_send',
  description: 'Cancel a recently-queued undo-send window, including provider-backed scheduled sends.',
  category: 'compose',
  mutating: true,
  input: z.object({ pendingId: z.string() }),
  output: z.object({ ok: z.boolean(), undone: z.boolean() }),
  async handler({ pendingId }, ctx) {
    // Lazy-load the pending queue from a shared module to avoid circular imports.
    const { cancelPending, parseProviderPendingId, rememberPendingStatus } = await import('../send/pending');
    const providerPending = parseProviderPendingId(pendingId, ctx.userId ?? undefined);
    if (providerPending) {
      const { stopNylasScheduledMessage } = await import('../nylas/provider');
      try {
        const result = await stopNylasScheduledMessage({
          userId: ctx.userId,
          account: providerPending.account,
          scheduleId: providerPending.scheduleId,
        });
        const undone = Boolean(result);
        rememberPendingStatus(pendingId, undone ? 'cancelled' : 'failed');
        return { ok: true, undone };
      } catch (err) {
        rememberPendingStatus(pendingId, 'failed', err);
        return { ok: true, undone: false };
      }
    }
    const undone = cancelPending(pendingId);
    return { ok: true, undone };
  },
});
