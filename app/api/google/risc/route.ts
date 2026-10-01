import { type NextRequest, NextResponse } from 'next/server';
import { handleRiscDelivery } from '@/lib/google/risc';

// Google Cross-Account Protection (RISC) push receiver (docs/google-risc.md).
// Google signs each Security Event Token; lib/google/risc.ts verifies the
// signature, the issuer, and the audience before it uses the token. The
// route is public in proxy.ts: Google has no Clerk session.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 16_384;

/**
 * Reads the body and stops at `max` bytes, also for a chunked request with no
 * Content-Length. Null when the body is larger than `max`.
 */
export async function readLimitedBody(req: Request, max: number): Promise<string | null> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return '';
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createRiscReceiver(handle: typeof handleRiscDelivery = handleRiscDelivery) {
  return async function riscReceiver(req: NextRequest) {
    const declared = Number(req.headers.get('content-length') || 0);
    if (declared > MAX_BODY_BYTES) {
      return NextResponse.json(
        { err: 'invalid_request', description: 'The token is too large.' },
        { status: 400 },
      );
    }
    const body = await readLimitedBody(req, MAX_BODY_BYTES);
    if (body === null) {
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
