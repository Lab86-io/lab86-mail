import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { ingestNylasWebhookPayload } from '@/lib/mail/corpus-sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const challenge = req.nextUrl.searchParams.get('challenge');
  if (challenge) return new Response(challenge, { status: 200 });
  return NextResponse.json({ ok: true });
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  const verification = verifyNylasSignature(req, rawBody);
  if (!verification.ok) {
    return NextResponse.json({ ok: false, error: verification.error }, { status: verification.status });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON payload.' }, { status: 400 });
  }

  try {
    const result = await ingestNylasWebhookPayload(payload);
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || 'Nylas webhook processing failed.' },
      { status: 500 },
    );
  }
}

// Nylas v3 signs webhook deliveries with HMAC-SHA256 over the raw body using
// the webhook secret issued when the destination was created. Without a
// verified signature this endpoint would be publicly writable, so deliveries
// are rejected when the secret is missing unless explicitly overridden for
// local development.
function verifyNylasSignature(
  req: NextRequest,
  rawBody: string,
): { ok: true } | { ok: false; status: number; error: string } {
  const secret = process.env.NYLAS_WEBHOOK_SECRET || '';
  if (!secret) {
    if (process.env.LAB86_MAIL_ALLOW_UNVERIFIED_WEBHOOKS === '1') return { ok: true };
    return {
      ok: false,
      status: 503,
      error: 'Webhook signature secret is not configured. Set NYLAS_WEBHOOK_SECRET.',
    };
  }
  const provided = req.headers.get('x-nylas-signature') || '';
  if (!provided) return { ok: false, status: 401, error: 'Missing webhook signature.' };
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const providedBuffer = Buffer.from(provided.trim().toLowerCase(), 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (providedBuffer.length !== expectedBuffer.length || !timingSafeEqual(providedBuffer, expectedBuffer)) {
    return { ok: false, status: 401, error: 'Invalid webhook signature.' };
  }
  return { ok: true };
}
