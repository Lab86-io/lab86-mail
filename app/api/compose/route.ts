import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { sendNylasMessage } from '@/lib/nylas/provider';
import { sanitizeFilename } from '@/lib/shared/files';
import { emailFromHeader } from '@/lib/shared/format';
import type { Message } from '@/lib/shared/types';
import { writeAudit } from '@/lib/store/audit';
import {
  getMessage as getMessageRecord,
  getThreadMessages,
  upsertMessage as upsertMessageRecord,
} from '@/lib/store/messages';
import { upsertThread } from '@/lib/store/threads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

type NylasAttachment = NonNullable<Parameters<typeof sendNylasMessage>[0]['attachments']>[number];

export async function POST(req: NextRequest) {
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

  const files = form.getAll('attachments').filter((value): value is File => value instanceof File);
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > MAX_TOTAL_BYTES) {
    return NextResponse.json(
      { ok: false, error: `Attachments exceed ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)}MB total` },
      { status: 413 },
    );
  }

  try {
    const user = await requireCurrentUser();
    const attachments: NylasAttachment[] = [];
    for (const file of files) {
      attachments.push({
        filename: sanitizeFilename(file.name || 'attachment'),
        contentType: file.type || 'application/octet-stream',
        content: Buffer.from(await file.arrayBuffer()),
        size: file.size,
      } as NylasAttachment);
    }

    const sent = await composeWithNylas({
      userId: user.userId,
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
    });
    await cacheSentMessage(account, sent);
    await writeAudit({
      tool: `compose_route:${mode || 'new'}:nylas`,
      userId: user.userId,
      account,
      args: {
        mode: mode || 'new',
        to,
        cc,
        bcc,
        subject,
        threadId,
        messageId,
        attachments: files.map((file) => file.name),
      },
      result: 'ok',
      agent: 'user',
    }).catch(() => undefined);

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
    const status = err instanceof AuthRequiredError ? 401 : 500;
    await writeAudit({
      tool: `compose_route:${mode || 'new'}:nylas`,
      userId: null,
      account,
      args: { mode: mode || 'new', to, subject, threadId, messageId },
      result: 'error',
      detail: err?.message,
      agent: 'user',
    }).catch(() => undefined);
    return NextResponse.json({ ok: false, error: err?.message || 'send failed' }, { status });
  }
}

async function composeWithNylas({
  userId,
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
}: {
  userId: string;
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
}): Promise<Message> {
  if (mode === 'reply' || mode === 'reply_all') {
    if (!messageId && !threadId) throw new Error('messageId or threadId is required for reply/reply_all');
    const target =
      mode === 'reply_all'
        ? await resolveReplyAllTarget(account, messageId, threadId)
        : await resolveReplyTarget(account, messageId, threadId);
    const sent = await sendNylasMessage({
      userId,
      account,
      to: to || target.to,
      cc,
      bcc,
      subject: subject || target.subject,
      body,
      html,
      replyToMessageId: messageId,
      attachments,
    });
    if (!sent) throw new Error('Connect this mailbox with Nylas before sending.');
    return sent;
  }

  if (mode === 'forward') {
    if (!messageId) throw new Error('messageId is required for forward');
    if (!to) throw new Error('to is required for forward');
    const original = await getMessageRecord(account, messageId);
    if (!original) {
      throw new Error('Cannot forward — original message not in local cache. Open the thread first.');
    }
    const fwdSubject =
      subject ||
      (original.subject?.startsWith('Fwd:')
        ? original.subject
        : `Fwd: ${original.subject || '(no subject)'}`);
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
          '<div style="border-left:2px solid currentColor;padding-left:.6em;opacity:.72">',
          '<div>---------- Forwarded message ----------</div>',
          `<div>From: ${escapeHtml(original.from)}</div>`,
          `<div>Date: ${new Date(original.date).toISOString()}</div>`,
          `<div>Subject: ${escapeHtml(original.subject || '')}</div>`,
          `<div>To: ${escapeHtml(original.to || '')}</div>`,
          original.cc ? `<div>Cc: ${escapeHtml(original.cc)}</div>` : '',
          '</div>',
          original.htmlBody || `<pre>${escapeHtml(original.textBody || '')}</pre>`,
        ].join('')
      : undefined;
    const sent = await sendNylasMessage({
      userId,
      account,
      to,
      cc,
      bcc,
      subject: fwdSubject,
      body: quotedText,
      html: quotedHtml,
      attachments,
    });
    if (!sent) throw new Error('Connect this mailbox with Nylas before sending.');
    return sent;
  }

  if (!to) throw new Error('to is required');
  if (!subject) throw new Error('subject is required');
  const sent = await sendNylasMessage({
    userId,
    account,
    to,
    cc,
    bcc,
    subject,
    body,
    html,
    attachments,
  });
  if (!sent) throw new Error('Connect this mailbox with Nylas before sending.');
  return sent;
}

async function cacheSentMessage(account: string, sent: Message) {
  await upsertMessageRecord(sent).catch(() => undefined);
  await upsertThread(sent.account || account, {
    _id: sent.threadId || sent._id,
    subject: sent.subject || '(no subject)',
    fromAddress: sent.from,
    lastDate: sent.date,
    snippet: sent.snippet || sent.textBody?.slice(0, 240) || '',
    labels: sent.labels || [],
    unread: false,
  }).catch(() => undefined);
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

async function resolveReplyAnchor(account: string, messageId?: string, threadId?: string) {
  const anchor =
    (messageId ? await getMessageRecord(account, messageId).catch(() => null) : null) ||
    (threadId
      ? (await getThreadMessages(account, threadId).catch(() => [])).sort(
          (a, b) => Number(b.date || 0) - Number(a.date || 0),
        )[0]
      : null);
  if (!anchor) {
    throw new Error(
      'Cannot reply — original message is not in the local cache. Reopen the thread and try again.',
    );
  }
  return anchor;
}

function escapeHtml(s: string): string {
  return String(s || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
