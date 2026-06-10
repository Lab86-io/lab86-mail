import { NextRequest, NextResponse } from 'next/server';
import { api, convexQuery } from '@/lib/hosted/convex';
import { reconcileMailCorpusAccount } from '@/lib/mail/corpus-sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const mailCorpusApi = (api as any).mailCorpus;

export async function POST(req: NextRequest) {
  const unauthorized = requireInternalRequest(req);
  if (unauthorized) return unauthorized;
  if (process.env.LAB86_MAIL_CORPUS_RECONCILE_ENABLED === '0') {
    return NextResponse.json({ ok: false, error: 'Corpus reconciliation is disabled.' }, { status: 503 });
  }

  const body = await req.json().catch(() => ({}));
  const userId = typeof body.userId === 'string' ? body.userId : undefined;
  const accountId = typeof body.accountId === 'string' ? body.accountId : undefined;
  const limit = typeof body.limit === 'number' ? body.limit : 10;
  // Partial targeting must not silently widen into a bulk sweep.
  if (Boolean(userId) !== Boolean(accountId)) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Provide both userId and accountId to target one account, or neither for a sweep.',
      },
      { status: 400 },
    );
  }

  try {
    if (userId && accountId) {
      const result = await reconcileMailCorpusAccount({ userId, accountId, limit: body.messageLimit });
      return NextResponse.json({ ok: true, results: [result] });
    }

    const targets = await convexQuery<any[]>(mailCorpusApi.listSyncTargets, {
      userId,
      status: body.status === 'idle' || body.status === 'backfilling' ? body.status : 'ready',
      limit,
    });
    const results = [];
    for (const target of targets.slice(0, Math.max(1, Math.min(limit, 25)))) {
      results.push(
        await reconcileMailCorpusAccount({
          userId: target.userId,
          accountId: target.accountId,
          limit: body.messageLimit,
        }),
      );
    }
    return NextResponse.json({ ok: true, results });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || 'Corpus reconciliation failed.' },
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
