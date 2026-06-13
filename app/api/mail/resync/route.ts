import { NextRequest, NextResponse } from 'next/server';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { runCorpusBackfill } from '@/lib/mail/corpus-sync';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// User-triggered "resync this mailbox": resets readiness and re-walks the
// whole mailbox from the top. Upserts are idempotent, so this re-indexes in
// place without a destructive wipe; the account stays searchable throughout.
export async function POST(req: NextRequest) {
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'mail_resync',
      limit: 10,
      windowMs: 10 * 60_000,
    });
    const body = await req.json().catch(() => ({}));
    const accountId = String(body.accountId || '');
    if (!accountId) {
      return NextResponse.json({ ok: false, error: 'accountId is required' }, { status: 400 });
    }
    const accounts = await convexQuery<any[]>(api.accounts.listConnectedAccounts, { userId: user.userId });
    const row = accounts.find((account) => account.accountId === accountId);
    if (!row || row.status !== 'connected') {
      return NextResponse.json({ ok: false, error: 'connected account not found' }, { status: 404 });
    }
    await convexMutation((api as any).mailCorpus.markSyncState, {
      userId: user.userId,
      accountId,
      grantId: row.grantId,
      provider: row.provider,
      status: 'backfilling',
      corpusReady: false,
      clearCursor: true,
      progress: { stage: 'resync_requested' },
    });
    void runCorpusBackfill({ userId: user.userId, accountId }).catch((err) => {
      console.error(`[resync] backfill failed for ${accountId}:`, err?.message || err);
    });
    return NextResponse.json({ ok: true, started: true });
  } catch (err: any) {
    if (err instanceof RateLimitError) return rateLimitJson(err);
    if (err instanceof AuthRequiredError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 401 });
    }
    return NextResponse.json({ ok: false, error: err?.message || 'Resync failed.' }, { status: 500 });
  }
}
