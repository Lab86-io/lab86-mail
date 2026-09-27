import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { runWithAiRequestContext } from '@/lib/ai/context';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { withAccountSignature } from '@/lib/mail/signature';
import { sendNylasMessage } from '@/lib/nylas/provider';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';
import {
  buildForwardMessagePayload,
  replyAllTargetFor,
  replyTargetFor,
  resolveSendAnchor,
} from '@/lib/send/anchor';
import { enqueueOutbox } from '@/lib/send/outbox';
import { sanitizeFilename } from '@/lib/shared/files';
import { DEFAULT_UNDO_SEND_SECONDS, normalizeUndoSendSeconds } from '@/lib/shared/sending';
import { truncateText } from '@/lib/shared/text';
import type { Message } from '@/lib/shared/types';
import { writeAudit } from '@/lib/store/audit';
import { upsertMessage as upsertMessageRecord } from '@/lib/store/messages';
import { getPref } from '@/lib/store/prefs';
import { upsertThread } from '@/lib/store/threads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

type NylasAttachment = NonNullable<Parameters<typeof sendNylasMessage>[0]['attachments']>[number];

const defaults = {
  requireCurrentUser,
  enforceUserRateLimit,
  enqueueOutbox,
  getPref,
  writeAudit,
  sendPrepared,
  cacheSentMessage,
  prepareComposeSend,
  applySignature: withAccountSignature,
};
export function createComposePost(overrides: Partial<typeof defaults> = {}) {
  const deps = { ...defaults, ...overrides };
  return async function POST(req: NextRequest) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch (err: any) {
      return NextResponse.json({ ok: false, error: `Invalid form: ${err?.message || err}` }, { status: 400 });
    }

    const mode = String(form.get('mode') || '').toLowerCase();
    const account = String(form.get('account') || '');
    if (!account) return NextResponse.json({ ok: false, error: 'account is required' }, { status: 400 });

    const to = (form.get('to') as string | null) || '';
    const cc = (form.get('cc') as string | null) || undefined;
    const bcc = (form.get('bcc') as string | null) || undefined;
    const subject = (form.get('subject') as string | null) || '';
    const body = (form.get('body') as string | null) || '';
    const html = (form.get('html') as string | null) || undefined;
    const threadId = (form.get('threadId') as string | null) || undefined;
    const messageId = (form.get('messageId') as string | null) || undefined;
    // The mailbox signature goes on by default; `signature=0` leaves it off
    // for this one message.
    const includeSignature = String(form.get('signature') ?? '1') !== '0';
    // Undo-send window (seconds, 0–300) and optional scheduled send time (epoch ms).
    const requestedUndoSeconds = form.has('undoSeconds')
      ? normalizeUndoSendSeconds(form.get('undoSeconds'))
      : undefined;
    const pendingId = String(form.get('pendingId') || `outbox:${crypto.randomUUID()}`);
    if (!/^outbox:[a-f0-9-]{36}$/.test(pendingId))
      return NextResponse.json({ ok: false, error: 'Invalid send key' }, { status: 400 });
    const sendAtRaw = Math.floor(Number(form.get('sendAt')) || 0);
    const sendAt = sendAtRaw > Date.now() + 60_000 ? sendAtRaw : undefined;
    if (sendAtRaw && !sendAt) {
      return NextResponse.json(
        { ok: false, error: 'Scheduled send time must be at least a minute in the future.' },
        { status: 400 },
      );
    }
    if (sendAt && sendAt > Date.now() + 30 * 24 * 60 * 60_000) {
      return NextResponse.json(
        { ok: false, error: 'Scheduled send time must be within 30 days.' },
        { status: 400 },
      );
    }

    const files = form.getAll('attachments').filter((value): value is File => value instanceof File);
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (total > MAX_TOTAL_BYTES) {
      return NextResponse.json(
        { ok: false, error: `Attachments exceed ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)}MB total` },
        { status: 413 },
      );
    }

    try {
      const user = await deps.requireCurrentUser();
      await deps.enforceUserRateLimit({
        userId: user.userId,
        key: 'compose',
        limit: 30,
        windowMs: 60_000,
      });
      const attachments: NylasAttachment[] = [];
      for (const file of files) {
        attachments.push({
          filename: sanitizeFilename(file.name || 'attachment'),
          contentType: file.type || 'application/octet-stream',
          content: Buffer.from(await file.arrayBuffer()),
          size: file.size,
        } as NylasAttachment);
      }

      const requestContext = {
        userId: user.userId,
        userEmail: user.email,
        userName: user.name,
        agent: 'user' as const,
      };
      const auditArgs = {
        mode: mode || 'new',
        to,
        cc,
        bcc,
        subject,
        threadId,
        messageId,
        attachments: files.map((file) => file.name),
      };
      // Reply/forward targets are resolved NOW, while the user is watching —
      // a missing anchor must fail the request, not a timer five minutes later.
      const prepared = await runWithAiRequestContext(requestContext, () =>
        deps.prepareComposeSend({
          account,
          mode,
          to,
          cc,
          bcc,
          subject,
          body,
          html,
          threadId,
          messageId,
          attachments,
          includeSignature,
          sign: deps.applySignature,
        }),
      );

      if (sendAt) {
        const sent = await runWithAiRequestContext(requestContext, async () => {
          const message = await deps.sendPrepared(user.userId, prepared, sendAt);
          await deps.cacheSentMessage(account, message);
          return message;
        });
        await deps
          .writeAudit({
            tool: `compose_route:${mode || 'new'}:scheduled`,
            userId: user.userId,
            account,
            args: { ...auditArgs, sendAt },
            result: 'ok',
            agent: 'user',
          })
          .catch(() => undefined);
        return NextResponse.json({
          ok: true,
          scheduled: { account, sendAt, messageId: sent._id },
        });
      }

      const undoSeconds =
        requestedUndoSeconds ??
        (await runWithAiRequestContext(requestContext, async () => {
          const raw = await deps.getPref('undoSendSeconds');
          return raw === null ? DEFAULT_UNDO_SEND_SECONDS : normalizeUndoSendSeconds(raw);
        }));
      if (undoSeconds > 0) {
        const pending = await deps.enqueueOutbox(user.userId, pendingId, undoSeconds, {
          ...prepared,
          userId: user.userId,
        });
        await deps
          .writeAudit({
            tool: `compose_route:${mode || 'new'}:held`,
            userId: user.userId,
            account,
            args: { ...auditArgs, pendingId, undoSeconds },
            result: 'ok',
            agent: 'user',
          })
          .catch(() => undefined);
        return NextResponse.json({ ok: true, pending: { ...pending, account, threadId: threadId || null } });
      }

      const sent = await runWithAiRequestContext(requestContext, async () => {
        const message = await deps.sendPrepared(user.userId, prepared);
        await deps.cacheSentMessage(account, message);
        return message;
      });
      await deps
        .writeAudit({
          tool: `compose_route:${mode || 'new'}:nylas`,
          userId: user.userId,
          account,
          args: auditArgs,
          result: 'ok',
          agent: 'user',
        })
        .catch(() => undefined);

      return NextResponse.json({
        ok: true,
        sent: {
          account,
          threadId: sent.threadId || threadId || sent._id,
          messageId: sent._id,
          refreshed: true,
        },
      });
    } catch (err: any) {
      if (err instanceof RateLimitError) return rateLimitJson(err);
      const status = err instanceof AuthRequiredError ? 401 : 500;
      await deps
        .writeAudit({
          tool: `compose_route:${mode || 'new'}:nylas`,
          userId: null,
          account,
          args: { mode: mode || 'new', to, subject, threadId, messageId },
          result: 'error',
          detail: err?.message,
          agent: 'user',
        })
        .catch(() => undefined);
      return NextResponse.json({ ok: false, error: err?.message || 'send failed' }, { status });
    }
  };
}
export const POST = createComposePost();

type PreparedSend = Omit<Parameters<typeof sendNylasMessage>[0], 'userId' | 'sendAt'>;

async function sendPrepared(userId: string, prepared: PreparedSend, sendAt?: number): Promise<Message> {
  const sent = await sendNylasMessage({ userId, ...prepared, sendAt });
  if (!sent) throw new Error('Connect this mailbox with Nylas before sending.');
  return sent;
}

async function prepareComposeSend({
  account,
  mode,
  to,
  cc,
  bcc,
  subject,
  body,
  html,
  threadId,
  messageId,
  attachments,
  includeSignature = true,
  sign = withAccountSignature,
}: {
  account: string;
  mode: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  html?: string;
  threadId?: string;
  messageId?: string;
  attachments: NylasAttachment[];
  includeSignature?: boolean;
  sign?: typeof withAccountSignature;
}): Promise<PreparedSend> {
  // The signature goes below what the user wrote. For a forward that is the
  // note above the forwarded message, so it is added before quoting.
  const signed = await sign({ account, body, html, include: includeSignature });
  body = signed.body;
  html = signed.html;
  if (mode === 'reply' || mode === 'reply_all') {
    if (!messageId && !threadId) throw new Error('messageId or threadId is required for reply/reply_all');
    const anchor = await resolveSendAnchor({ account, messageId, threadId });
    const target = mode === 'reply_all' ? replyAllTargetFor(anchor, account) : replyTargetFor(anchor);
    return {
      account,
      to: to || target.to,
      cc,
      bcc,
      subject: subject || target.subject,
      body,
      html,
      replyToMessageId: target.replyToMessageId,
      attachments,
    };
  }

  if (mode === 'forward') {
    if (!messageId) throw new Error('messageId is required for forward');
    if (!to) throw new Error('to is required for forward');
    const original = await resolveSendAnchor({ account, messageId, threadId });
    const quoted = buildForwardMessagePayload(original, { body, html });
    return {
      account,
      to,
      cc,
      bcc,
      subject: subject || quoted.subject,
      body: quoted.body,
      html: quoted.html,
      attachments,
    };
  }

  if (!to) throw new Error('to is required');
  if (!subject) throw new Error('subject is required');
  return { account, to, cc, bcc, subject, body, html, attachments };
}

async function cacheSentMessage(account: string, sent: Message) {
  await upsertMessageRecord(sent).catch(() => undefined);
  await upsertThread(sent.account || account, {
    _id: sent.threadId || sent._id,
    subject: sent.subject || '(no subject)',
    fromAddress: sent.from,
    lastDate: sent.date,
    snippet: sent.snippet || truncateText(sent.textBody, 240) || '',
    labels: sent.labels || [],
    unread: false,
  }).catch(() => undefined);
}
