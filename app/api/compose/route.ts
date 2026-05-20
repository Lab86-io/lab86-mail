import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { buildReplyArgs, buildSendArgs } from '@/lib/compose/gog-args';
import { runGogJson } from '@/lib/gog/pool';
import { sanitizeFilename } from '@/lib/shared/files';
import { writeAudit } from '@/lib/store/audit';
import { getMessage as getMessageRecord } from '@/lib/store/messages';

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
      if (!messageId) {
        return NextResponse.json(
          { ok: false, error: 'messageId is required for reply/reply_all' },
          { status: 400 },
        );
      }
      args = buildReplyArgs({
        account,
        messageId,
        threadId,
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
            `<div style="border-left:2px solid #ccc;padding-left:.6em;color:#666">`,
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

    await runGogJson<any>(args, { timeoutMs: 120_000 });
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
    return NextResponse.json({ ok: true });
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

function escapeHtml(s: string): string {
  return String(s || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
