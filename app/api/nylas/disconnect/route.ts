import { NextRequest, NextResponse } from 'next/server';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexQuery } from '@/lib/hosted/convex';
import { deleteNylasAccount } from '@/lib/nylas/provider';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'nylas_disconnect',
      limit: 30,
      windowMs: 10 * 60_000,
    });
    const body = await req.json().catch(() => ({}));
    const accountId = String(body.accountId || '');
    if (!accountId) {
      return NextResponse.json({ ok: false, error: 'accountId is required' }, { status: 400 });
    }
    const accounts = await convexQuery<any[]>(api.accounts.listConnectedAccounts, { userId: user.userId });
    const row = accounts.find((account) => account.accountId === accountId);
    if (!row) return NextResponse.json({ ok: false, error: 'connected account not found' }, { status: 404 });
    await deleteNylasAccount(user.userId, row.accountId, row.grantId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof RateLimitError) return rateLimitJson(err);
    throw err;
  }
}
