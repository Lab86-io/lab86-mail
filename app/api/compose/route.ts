import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { buildReplyArgs, buildSendArgs } from '@/lib/compose/gog-args';
import { runGogJson } from '@/lib/gog/pool';
import { sanitizeFilename } from '@/lib/shared/files';
import { emailFromHeader } from '@/lib/shared/format';
import { writeAudit } from '@/lib/store/audit';
import { getMessage as getMessageRecord, getThreadMessages } from '@/lib/store/messages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

// Single multipart endpoint for the human composer. Why not the JSON tool
// route? Because attachments are real files — base64-in-JSON would balloon
// payload size 1.3x and force us to round-trip arrays of bytes through the
// agent registry. Instead we accept FormData, spool files to a temp dir,
// hand the paths to gog via the shared arg builders, and clean up after.
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
  const from = (form.get('from') as string | null) || undefined;

  const files = form.getAll('attachments').filter((v): v is File => v instanceof File);
  let total = 0;
  for (const f of files) total += f.size;
  if (total > MAX_TOTAL_BYTES) {
    return NextResponse.json(
      { ok: false, error: `Attachments exceed ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)}MB total` },
      { status: 413 },
    );
  }

  const dir = await fs.mkdtemp(path.join(tmpdir(), 'mailos-compose-'));
  const attachmentPaths: string[] = [];
  try {
    for (const f of files) {
      const safe = sanitizeFilename(f.name || 'attachment');
      const target = path.join(dir, safe);
      const buf = Buffer.from(await f.arrayBuffer());
      await fs.writeFile(target, new Uint8Array(buf));
      attachmentPaths.push(target);
    }

    let args: string[];
    if (mode === 'reply' || mode === 'reply_all') {
      if (!messageId && !threadId) {
        return NextResponse.json(
          { ok: false, error: 'messageId or threadId is required for reply/reply_all' },
          { status: 400 },
        );
      }
      const replyTarget = mode === 'reply' ? await resolveReplyTarget(account, messageId, threadId) : null;
      args = buildReplyArgs({
        account,
        messageId,
        threadId,
        to: replyTarget?.to,
        subject: replyTarget?.subject,
        body,
        html,
        from,
        replyAll: mode === 'reply_all',
        attachmentPaths,
      });
    } else if (mode === 'forward') {
      if (!messageId) {
        return NextResponse.json({ ok: false, error: 'messageId is required for forward' }, { status: 400 });
      }
      if (!to) return NextResponse.json({ ok: false, error: 'to is required for forward' }, { status: 400 });
      // Forward is sent as a fresh message with a quoted body — mirror the
      // forward tool's synthesis so the human path matches the agent path.
      const original = await getMessageRecord(account, messageId);
      if (!original) {
        return NextResponse.json(
          {
            ok: false,
            error: 'Cannot forward — original message not in local cache. Open the thread first.',
          },
          { status: 400 },
        );
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
      args = buildSendArgs({
        account,
        to,
        cc,
        bcc,
        subject: fwdSubject,
        body: quotedText,
        html: quotedHtml,
        from,
        attachmentPaths,
      });
    } else {
      // Default: brand-new message.
      if (!to) return NextResponse.json({ ok: false, error: 'to is required' }, { status: 400 });
      if (!subject) return NextResponse.json({ ok: false, error: 'subject is required' }, { status: 400 });
      args = buildSendArgs({ account, to, cc, bcc, subject, body, html, from, attachmentPaths });
    }

    const rawSend = await runGogJson<any>(args, { timeoutMs: 120_000 });
    const sent = await resolveSentMessage({
      account,
      mode: mode || 'new',
      to,
      subject,
      threadId,
      messageId,
      rawSend,
    });
    await writeAudit({
      tool: `compose_route:${mode || 'new'}`,
      account,
      args: {
        mode: mode || 'new',
        to,
        cc,
        bcc,
        subject,
        threadId,
        messageId,
        attachments: files.map((f) => f.name),
      },
      result: 'ok',
      agent: 'user',
    }).catch(() => undefined);
    return NextResponse.json({ ok: true, sent });
  } catch (err: any) {
    await writeAudit({
      tool: `compose_route:${mode || 'new'}`,
      account,
      args: { mode: mode || 'new', to, subject, threadId, messageId },
      result: 'error',
      detail: err?.message,
      agent: 'user',
    }).catch(() => undefined);
    return NextResponse.json({ ok: false, error: err?.message || 'send failed' }, { status: 500 });
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function resolveSentMessage({
  account,
  mode,
  to,
  subject,
  threadId,
  messageId,
  rawSend,
}: {
  account: string;
  mode: string;
  to: string;
  subject: string;
  threadId?: string;
  messageId?: string;
  rawSend: any;
}) {
  const fromSend = extractIds(rawSend);
  if (fromSend.threadId || fromSend.messageId) {
    return {
      account,
      threadId: fromSend.threadId || threadId || fromSend.messageId,
      messageId: fromSend.messageId || fromSend.threadId || messageId,
    };
  }

  if ((mode === 'reply' || mode === 'reply_all') && threadId) {
    return { account, threadId, messageId: messageId || threadId };
  }

  // Gmail search indexing can lag just after send. Poll briefly so the UI can
  // open the exact sent thread instead of dropping back to the previously-read
  // message. Search by recipient as well as subject because Gmail subject
  // search is exact enough to be brittle with emoji/punctuation differences.
  const recipient = firstEmail(to);
  const subjectText = subject.trim();
  const queries = [
    recipient && subjectText
      ? `in:sent newer_than:2d to:${gmailTerm(recipient)} subject:${gmailQuote(subjectText)}`
      : '',
    recipient ? `in:sent newer_than:2d to:${gmailTerm(recipient)}` : '',
    subjectText ? `in:sent newer_than:2d subject:${gmailQuote(subjectText)}` : '',
    'in:sent newer_than:2d',
  ].filter(Boolean);
  const wantedSubject = normalizeSubject(subjectText);
  for (let i = 0; i < 12; i++) {
    if (i > 0) await sleep(750);
    try {
      for (const query of queries) {
        const raw = await runGogJson<any>([
          '--account',
          account,
          '--json',
          '--results-only',
          'gmail',
          'search',
          '--max',
          '10',
          '--no-input',
          '--',
          query,
        ]);
        const candidates = coerceList(raw)
          .map((item) => ({
            id: String(item.threadId || item.thread_id || item.id || item.messageId || item.message_id || ''),
            messageId: String(item.messageId || item.message_id || item.id || ''),
            subject: String(item.subject || item.Subject || ''),
            date: Number(
              item.internalDate || item.internal_date || Date.parse(item.date || item.Date || '') || 0,
            ),
          }))
          .filter((item) => item.id)
          .sort((a, b) => b.date - a.date);
        const chosen =
          (wantedSubject && candidates.find((item) => normalizeSubject(item.subject) === wantedSubject)) ||
          candidates[0];
        if (chosen) return { account, threadId: chosen.id, messageId: chosen.messageId || chosen.id };
      }
    } catch {}
  }

  return { account, threadId: threadId || messageId || null, messageId: messageId || null };
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
    throw new Error(
      'Cannot reply — original message is not in the local cache. Reopen the thread and try again.',
    );
  }
  const to = emailFromHeader(anchor.from) || anchor.from;
  if (!to) throw new Error('Cannot reply — original sender is missing.');
  return {
    to,
    subject: anchor.subject?.startsWith('Re:') ? anchor.subject : `Re: ${anchor.subject || '(no subject)'}`,
  };
}

function extractIds(raw: any): { threadId?: string; messageId?: string } {
  const obj = raw?.message || raw?.result || raw?.data || raw?.sent || raw;
  return {
    threadId: obj?.threadId || obj?.thread_id || obj?.thread?.id,
    messageId: obj?.id || obj?.messageId || obj?.message_id,
  };
}

function coerceList(raw: any): any[] {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.messages)) return raw.messages;
  if (Array.isArray(raw?.threads)) return raw.threads;
  if (Array.isArray(raw?.results)) return raw.results;
  if (Array.isArray(raw?.items)) return raw.items;
  if (Array.isArray(raw?.data)) return raw.data;
  return [];
}

function gmailQuote(s: string): string {
  return `"${String(s).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function gmailTerm(s: string): string {
  return /\s/.test(s) ? gmailQuote(s) : s;
}

function firstEmail(value: string): string {
  const match = String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return (
    match?.[0] ||
    String(value || '')
      .split(',')[0]
      ?.trim() ||
    ''
  );
}

function normalizeSubject(value: string): string {
  return String(value || '')
    .replace(/^(re|fwd?):\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(s: string): string {
  return String(s || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
