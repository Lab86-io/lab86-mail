import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { runLlmClassificationSweep } from '@/lib/mail/llm-classify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: NextRequest) {
  const expected = process.env.LAB86_CONVEX_INTERNAL_SECRET || '';
  const supplied = request.headers.get('x-lab86-internal-secret') || '';
  if (
    !expected ||
    Buffer.byteLength(expected) !== Buffer.byteLength(supplied) ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))
  )
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await request.json().catch(() => null);
  if (typeof body?.userId !== 'string' || !body.userId || body.userId.length > 200)
    return NextResponse.json({ error: 'A user is required.' }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, ...(await runLlmClassificationSweep(body.userId)) });
  } catch {
    return NextResponse.json({ ok: false, error: 'Jev classification is unavailable.' }, { status: 503 });
  }
}
