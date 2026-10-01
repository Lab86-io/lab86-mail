import { type NextRequest, NextResponse } from 'next/server';
import { handleRiscDelivery } from '@/lib/google/risc';

// Google Cross-Account Protection (RISC) push receiver (docs/google-risc.md).
// Google signs each Security Event Token; lib/google/risc.ts verifies the
// signature, the issuer, and the audience before it uses the token. The
// route is public in proxy.ts: Google has no Clerk session.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 16_384;

export function createRiscReceiver(handle: typeof handleRiscDelivery = handleRiscDelivery) {
  return async function riscReceiver(req: NextRequest) {
    const declared = Number(req.headers.get('content-length') || 0);
    if (declared > MAX_BODY_BYTES) {
      return NextResponse.json(
        { err: 'invalid_request', description: 'The token is too large.' },
        { status: 400 },
      );
    }
    const body = await req.text().catch(() => '');
    if (body.length > MAX_BODY_BYTES) {
      return NextResponse.json(
        { err: 'invalid_request', description: 'The token is too large.' },
        { status: 400 },
      );
    }
    const result = await handle({ body, contentType: req.headers.get('content-type') });
    if (result.status === 202) return new NextResponse(null, { status: 202 });
    return NextResponse.json({ err: result.err, description: result.description }, { status: result.status });
  };
}

export const POST = createRiscReceiver();
