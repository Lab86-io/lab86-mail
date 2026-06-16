import { NextRequest, NextResponse } from 'next/server';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { syncCalendarAccount } from '@/lib/calendar/sync';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// User-triggered "resync this account's calendars": full window re-walk with
// reconcile, so deletions and edits made elsewhere converge immediately.
export async function POST(req: NextRequest) {
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'calendar_resync',
      limit: 10,
      windowMs: 10 * 60_000,
    });
    const body = await req.json().catch(() => ({}));
    const accountId = String(body.accountId || '');
    if (!accountId) {
      return NextResponse.json({ ok: false, error: 'accountId is required' }, { status: 400 });
    }
    void syncCalendarAccount({ userId: user.userId, accountId, force: true, reason: 'manual_http' }).catch(
      (err) => {
        console.error(`[resync] calendar sync failed for ${accountId}:`, err?.message || err);
      },
    );
    return NextResponse.json({ ok: true, started: true });
  } catch (err: any) {
    if (err instanceof RateLimitError) return rateLimitJson(err);
    if (err instanceof AuthRequiredError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 401 });
    }
    return NextResponse.json({ ok: false, error: err?.message || 'Resync failed.' }, { status: 500 });
  }
}
