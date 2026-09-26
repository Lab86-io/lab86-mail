import type { CreateAttachmentRequest } from 'nylas';
import { z } from 'zod';
import { recordOperation, registerUndoExecutor } from '../ai/operations';
import { fetchEmailAttachment, fetchWebFile } from '../attachments/fetch-store';
import { convexInternalSecret, isConvexConfigured } from '../hosted/env';
import { listNylasScheduledMessages, sendNylasMessage, stopNylasScheduledMessage } from '../nylas/provider';
import {
  buildForwardMessagePayload,
  replyAllTargetFor,
  replyTargetFor,
  resolveSendAnchor,
} from '../send/anchor';
import { cancelOutbox } from '../send/outbox';
import type { Draft } from '../shared/types';
import {
  deleteDraft as deleteDraftRecord,
  getDraft,
  listDrafts,
  saveDraft as saveDraftRecord,
} from '../store/drafts';
import { defineTool, type ToolContext } from './registry';

export { buildForwardMessagePayload };

export async function recordSavedDraftOperation(
  input: {
    ctx: Pick<ToolContext, 'userId' | 'operationBatchId'>;
    args: Pick<Draft, 'subject'>;
    saved: Pick<Draft, '_id' | 'account'>;
  },
  recorder = recordOperation,
) {
  if (!input.ctx.userId || !isConvexConfigured() || !convexInternalSecret()) return undefined;
  return recorder({
    userId: input.ctx.userId,
    tool: 'save_draft',
    surface: 'mail',
    summary: `Saved draft "${input.args.subject || '(no subject)'}"`,
    batchId: input.ctx.operationBatchId,
    target: { kind: 'emailDraft', id: input.saved._id, accountId: input.saved.account },
    inverse: { kind: 'compose.delete_draft', payload: { draftId: input.saved._id } },
  });
}

export async function saveDraftAndRecordOperation(
  input: {
    ctx: Pick<ToolContext, 'userId' | 'operationBatchId'>;
    doc: Draft;
    args: Pick<Draft, 'subject'>;
  },
  helpers = {
    saveDraft: saveDraftRecord,
    deleteDraft: deleteDraftRecord,
    recordOperation: recordSavedDraftOperation,
  },
) {
  const saved = await helpers.saveDraft(input.doc);
  let operationId: string | undefined;
  try {
    operationId = await helpers.recordOperation({ ctx: input.ctx, args: input.args, saved });
  } catch (error) {
    if (saved._id) await helpers.deleteDraft(saved._id).catch(() => undefined);
    throw error;
  }
  return { saved, operationId };
}

// Attachment sources the agent can pull and send: a web url, or a file off
// an existing email. Both resolve to bytes server-side at send time. Kept flat
// (rather than a discriminated union) so the model doesn't need a type tag, but
// refined to reject empty/ambiguous shapes up front.
const AttachmentSource = z
  .object({
    name: z.string().optional(),
    url: z.string().optional(),
    account: z.string().optional(),
    messageId: z.string().optional(),
    attachmentId: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    const isWeb = Boolean(value.url);
    const isEmail = Boolean(value.account && value.messageId && value.attachmentId);
    if (isWeb && isEmail) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide either url OR account+messageId+attachmentId, not both.',
      });
    }
    if (!isWeb && !isEmail) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Each attachment needs a url, or account + messageId + attachmentId.',
      });
    }
  });
type AttachmentSourceInput = z.infer<typeof AttachmentSource>;

const SendBase = z.object({
  account: z.string(),
  to: z.string(),
  cc: z.string().optional(),
  bcc: z.string().optional(),
  subject: z.string(),
  body: z.string(),
  html: z.string().optional(),
  attachments: z.array(AttachmentSource).optional(),
});

// Resolve attachment descriptors to Nylas CreateAttachmentRequest payloads
// (filename + contentType + base64 content). Used by every send path so the
// AI can "pull this file from the web / that email and attach it."
async function resolveSendAttachments(
  userId: string | null | undefined,
  sources: AttachmentSourceInput[] | undefined,
): Promise<CreateAttachmentRequest[] | undefined> {
  if (!sources?.length) return undefined;
  if (!userId) throw new Error('Sign in required to attach files.');
  const resolved: CreateAttachmentRequest[] = [];
  for (const source of sources) {
    const blob = source.url
      ? await fetchWebFile(source.url, source.name)
      : source.account && source.messageId && source.attachmentId
        ? await fetchEmailAttachment(
            userId,
            source.account,
            source.attachmentId,
            source.messageId,
            source.name,
          )
        : null;
    if (!blob) throw new Error('Each attachment needs a url, or account + messageId + attachmentId.');
    resolved.push({
      filename: source.name?.trim() || blob.name,
      contentType: blob.contentType,
      content: Buffer.from(blob.bytes),
      // Without a size the SDK takes the JSON path, which Nylas caps at 3 MB.
      size: blob.bytes.byteLength,
    });
  }
  return resolved;
}

async function sendWithNylas(args: Parameters<typeof sendNylasMessage>[0]) {
  const sent = await sendNylasMessage(args);
  if (!sent) throw new Error('Connect this mailbox with Nylas before sending.');
  return sent;
}

// The provider's identity for what was just sent, so callers (the mobile
// command executor in particular) can key sync changes on the real thread.
const SentOutput = z.object({
  ok: z.boolean(),
  messageId: z.string().optional(),
  threadId: z.string().optional(),
});

function sentResult(sent: { _id?: unknown; threadId?: unknown }) {
  const messageId = typeof sent?._id === 'string' && sent._id ? sent._id : undefined;
  const threadId = typeof sent?.threadId === 'string' && sent.threadId ? sent.threadId : undefined;
  return { ok: true as const, messageId, threadId };
}

// Reply recipients default to the anchor message. A caller that edited them
// (the mobile composer, for one) passes its own to, cc, bcc, and subject.
const ReplyInput = z.object({
  account: z.string(),
  messageId: z.string(),
  threadId: z.string().optional(),
  to: z.string().optional(),
  cc: z.string().optional(),
  bcc: z.string().optional(),
  subject: z.string().optional(),
  body: z.string(),
  html: z.string().optional(),
  attachments: z.array(AttachmentSource).optional(),
});

export const sendMessage = defineTool({
  name: 'send_message',
  description: 'Send a brand-new email.',
  category: 'compose',
  risk: 'reach_person',
  mutating: true,
  input: SendBase,
  output: SentOutput,
  async handler({ account, to, cc, bcc, subject, body, html, attachments }, ctx) {
    const resolved = await resolveSendAttachments(ctx.userId, attachments);
    const sent = await sendWithNylas({
      userId: ctx.userId,
      account,
      to,
      cc,
      bcc,
      subject,
      body,
      html,
      attachments: resolved,
    });
    return sentResult(sent as any);
  },
});

export const replyMessage = defineTool({
  name: 'reply',
  description: 'Reply to a single message (to its sender).',
  category: 'compose',
  risk: 'reach_person',
  mutating: true,
  input: ReplyInput,
  output: SentOutput,
  async handler({ account, messageId, threadId, to, cc, bcc, subject, body, html, attachments }, ctx) {
    const anchor = await resolveSendAnchor({ account, messageId, threadId, userId: ctx.userId });
    const target = replyTargetFor(anchor);
    const sent = await sendWithNylas({
      userId: ctx.userId,
      account,
      to: to?.trim() || target.to,
      cc,
      bcc,
      subject: subject?.trim() || target.subject,
      body,
      html,
      replyToMessageId: target.replyToMessageId,
      attachments: await resolveSendAttachments(ctx.userId, attachments),
    });
    return sentResult(sent as any);
  },
});

export const replyAllMessage = defineTool({
  name: 'reply_all',
  description: 'Reply-all to a message (everyone on To: + Cc:).',
  category: 'compose',
  risk: 'reach_person',
  mutating: true,
  input: ReplyInput,
  output: SentOutput,
  async handler({ account, messageId, threadId, to, cc, bcc, subject, body, html, attachments }, ctx) {
    const anchor = await resolveSendAnchor({ account, messageId, threadId, userId: ctx.userId });
    const target = replyAllTargetFor(anchor, account);
    const recipients = to?.trim() || target.to;
    if (!recipients) throw new Error('Cannot reply-all — no recipients are available.');
    const sent = await sendWithNylas({
      userId: ctx.userId,
      account,
      to: recipients,
      cc,
      bcc,
      subject: subject?.trim() || target.subject,
      body,
      html,
      replyToMessageId: target.replyToMessageId,
      attachments: await resolveSendAttachments(ctx.userId, attachments),
    });
    return sentResult(sent as any);
  },
});

export const forwardMessage = defineTool({
  name: 'forward',
  description:
    'Forward a message to one or more recipients. Synthesizes a quoted body from the original. To re-carry the original file(s), pass attachments: [{ account, messageId, attachmentId }] (find ids via list_attachments).',
  category: 'compose',
  risk: 'reach_person',
  mutating: true,
  input: z.object({
    account: z.string(),
    messageId: z.string(),
    to: z.string(),
    cc: z.string().optional(),
    bcc: z.string().optional(),
    body: z.string().optional(),
    html: z.string().optional(),
    attachments: z.array(AttachmentSource).optional(),
  }),
  output: SentOutput,
  async handler({ account, messageId, to, cc, bcc, body, html, attachments }, ctx) {
    const original = await resolveSendAnchor({ account, messageId, userId: ctx.userId });
    const quoted = buildForwardMessagePayload(original, { body, html });
    const sent = await sendWithNylas({
      userId: ctx.userId,
      account,
      to,
      cc,
      bcc,
      subject: quoted.subject,
      body: quoted.body,
      html: quoted.html,
      attachments: await resolveSendAttachments(ctx.userId, attachments),
    });
    return sentResult(sent as any);
  },
});

export const saveDraftTool = defineTool({
  name: 'save_draft',
  description: 'Persist a draft locally (not yet uploaded to Gmail).',
  category: 'compose',
  risk: 'write_self',
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
  output: z.object({ ok: z.boolean(), draft: z.any(), operationId: z.string().optional() }),
  async handler(args, ctx) {
    const doc: Draft = { ...args, updatedAt: Date.now() };
    const { saved, operationId } = await saveDraftAndRecordOperation({ ctx, doc, args });
    return { ok: true, draft: saved, operationId };
  },
});

export const updateDraft = defineTool({
  name: 'update_draft',
  description: 'Update an existing local draft by id.',
  category: 'compose',
  risk: 'write_self',
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
      // `null` clears a scheduled send; `undefined` leaves it unchanged.
      scheduledFor: z.number().nullable().optional(),
    }),
  }),
  output: z.object({ ok: z.boolean() }),
  async handler({ id, patch }) {
    const draft = await getDraft(id);
    if (!draft) throw new Error('Draft not found');
    const { scheduledFor, ...fields } = patch;
    Object.assign(draft, fields);
    if (scheduledFor === null) delete (draft as { scheduledFor?: number }).scheduledFor;
    else if (scheduledFor !== undefined) (draft as { scheduledFor?: number }).scheduledFor = scheduledFor;
    await saveDraftRecord(draft);
    return { ok: true };
  },
});

export const deleteDraftTool = defineTool({
  name: 'delete_draft',
  description: 'Delete a local draft.',
  category: 'compose',
  risk: 'destructive',
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

registerUndoExecutor('compose.delete_draft', async (payload) => {
  if (!payload?.draftId) throw new Error('draftId required.');
  await deleteDraftRecord(payload.draftId);
});

export const scheduleSend = defineTool({
  name: 'schedule_send',
  description:
    'Schedule an email to send at a future time (provider-side via Nylas send_at). Returns a scheduleId usable with cancel_scheduled.',
  category: 'compose',
  risk: 'reach_person',
  mutating: true,
  input: SendBase.extend({ scheduledFor: z.number().describe('Epoch ms when to send') }),
  output: z.object({ ok: z.boolean(), scheduleId: z.string().optional(), messageId: z.string().optional() }),
  async handler({ account, to, cc, bcc, subject, body, html, attachments, scheduledFor }, ctx) {
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
      attachments: await resolveSendAttachments(ctx.userId, attachments),
      sendAt: scheduledFor,
    });
    return { ok: true, scheduleId: (sent as any).scheduleId, messageId: sent._id };
  },
});

export const cancelScheduled = defineTool({
  name: 'cancel_scheduled',
  description: 'Cancel a scheduled send by its Nylas scheduleId (see list_scheduled / schedule_send).',
  category: 'compose',
  risk: 'destructive',
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

const UNDO_NOTHING = 'Nothing was undone. The message may have already gone out, or the undo window closed.';

export const undoSend = defineTool({
  name: 'undo_send',
  description:
    'Cancel a message that is still in its undo-send window. Pass the pendingId from the send receipt (an outbox: key, or a provider-backed scheduled send).',
  category: 'compose',
  risk: 'write_self',
  mutating: true,
  input: z.object({ pendingId: z.string() }),
  output: z.object({ ok: z.boolean(), undone: z.boolean(), error: z.string().optional() }),
  async handler({ pendingId }, ctx) {
    const result = (undone: boolean) =>
      undone ? { ok: true, undone } : { ok: false, undone, error: UNDO_NOTHING };
    // Every current send holds in the Convex outbox under an `outbox:` key.
    if (pendingId.startsWith('outbox:')) {
      if (!ctx.userId) throw new Error('Sign in required to undo a send.');
      return result(Boolean(await cancelOutbox(ctx.userId, pendingId)));
    }
    // Lazy-load the pending queue from a shared module to avoid circular imports.
    const { cancelPending, parseProviderPendingId, rememberPendingStatus } = await import('../send/pending');
    const providerPending = parseProviderPendingId(pendingId, ctx.userId ?? undefined);
    if (providerPending) {
      try {
        const cancelled = await stopNylasScheduledMessage({
          userId: ctx.userId,
          account: providerPending.account,
          scheduleId: providerPending.scheduleId,
        });
        const undone = Boolean(cancelled);
        rememberPendingStatus(pendingId, undone ? 'cancelled' : 'failed');
        return result(undone);
      } catch (err) {
        rememberPendingStatus(pendingId, 'failed', err);
        return result(false);
      }
    }
    return result(cancelPending(pendingId));
  },
});
