import { NextRequest, NextResponse } from 'next/server';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation } from '@/lib/hosted/convex';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest) {
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'nylas_account_patch',
      limit: 60,
      windowMs: 60_000,
    });
    const body = await req.json().catch(() => ({}));
    const accountId = String(body.accountId || '');
    if (!accountId) {
      return NextResponse.json({ ok: false, error: 'accountId is required' }, { status: 400 });
    }
    await convexMutation(api.accounts.updateConnectedAccountAlias, {
      userId: user.userId,
      accountId,
      displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof RateLimitError) return rateLimitJson(err);
    throw err;
  }
}
