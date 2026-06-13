import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { enqueueNylasWebhook, webhookQueueDepth } from '@/lib/mail/webhook-queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const challenge = req.nextUrl.searchParams.get('challenge');
  if (challenge) return new Response(challenge, { status: 200 });
  return NextResponse.json({ ok: true });
}

export async function POST(req: NextRequest) {
  // Verify over the exact bytes Nylas signed. Decoding to a string first
  // (req.text()) replaces any byte sequence that isn't valid UTF-8, so the
  // recomputed HMAC silently diverges for payloads carrying such bytes —
  // which made signature checks fail content-dependently and flagged the
  // whole subscription as failing.
  const rawBytes = Buffer.from(await req.arrayBuffer());

  const verification = verifyNylasSignature(req, rawBytes);
  if (!verification.ok) {
    logRejectedDelivery(rawBytes, verification.error);
    return NextResponse.json({ ok: false, error: verification.error }, { status: verification.status });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBytes.toString('utf8'));
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON payload.' }, { status: 400 });
  }

  // ACK before processing: Nylas times deliveries out at ~20s and flags the
  // subscription as failing after 15 minutes of timeouts. Ingest (provider
  // fetch + corpus upsert + classification) runs from an in-process queue;
  // events are idempotent by eventId and the reconciler repairs any gap.
  // If the buffer is full, return 503 so Nylas retries rather than dropping
  // the delivery (the reconciler does not replay deletes).
  const accepted = enqueueNylasWebhook(payload);
  if (!accepted) {
    return NextResponse.json(
      { ok: false, error: 'Webhook queue saturated; retry later.', queue: webhookQueueDepth() },
      { status: 503 },
    );
  }
  return NextResponse.json({ ok: true, accepted: true, queue: webhookQueueDepth() });
}

// Nylas v3 signs webhook deliveries with HMAC-SHA256 over the raw body using
// the webhook secret issued when the destination was created. Without a
// verified signature this endpoint would be publicly writable, so deliveries
// are rejected when the secret is missing unless explicitly overridden for
// local development.
function verifyNylasSignature(
  req: NextRequest,
  rawBytes: Buffer,
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
  const expected = createHmac('sha256', secret).update(rawBytes).digest('hex');
  const providedBuffer = Buffer.from(provided.trim().toLowerCase(), 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (providedBuffer.length !== expectedBuffer.length || !timingSafeEqual(providedBuffer, expectedBuffer)) {
    return { ok: false, status: 401, error: 'Invalid webhook signature.' };
  }
  return { ok: true };
}

// Rejected deliveries log their non-sensitive envelope (event type, source
// application, grant) so a rogue sender or secret mismatch is identifiable
// from Railway logs without storing message content.
function logRejectedDelivery(rawBytes: Buffer, reason: string) {
  try {
    const payload = JSON.parse(rawBytes.toString('utf8')) as any;
    console.warn(
      `[nylas-webhook] rejected: ${reason} type=${payload?.type} app=${payload?.data?.application_id} grant=${payload?.data?.object?.grant_id}`,
    );
  } catch {
    console.warn(`[nylas-webhook] rejected: ${reason} (unparseable payload, ${rawBytes.length} bytes)`);
  }
}
