import { NextRequest, NextResponse } from 'next/server';
import { backfillMailCorpusAccount } from '@/lib/mail/corpus-sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const unauthorized = requireInternalRequest(req);
  if (unauthorized) return unauthorized;

  const body = await req.json().catch(() => ({}));
  const userId = String(body.userId || '');
  const accountId = String(body.accountId || '');
  if (!userId || !accountId) {
    return NextResponse.json({ ok: false, error: 'userId and accountId are required.' }, { status: 400 });
  }

  try {
    const result = await backfillMailCorpusAccount({
      userId,
      accountId,
      pageToken: typeof body.pageToken === 'string' ? body.pageToken : undefined,
      limit: typeof body.limit === 'number' ? body.limit : undefined,
    });
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || 'Corpus backfill failed.' },
      { status: 500 },
    );
  }
}

function requireInternalRequest(req: NextRequest) {
  const expected = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  const provided =
    req.headers.get('x-lab86-internal-secret') ||
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!expected || provided !== expected) {
    return NextResponse.json({ ok: false, error: 'Unauthorized.' }, { status: 401 });
  }
  return null;
}
