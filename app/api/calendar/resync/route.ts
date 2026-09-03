import { type NextRequest, NextResponse } from 'next/server';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import {
  CALENDAR_RESYNC_CLIENT_REASONS,
  consumesCalendarResyncRateLimit,
  parseCalendarResyncReason,
  startCalendarResync,
} from '@/lib/calendar/resync';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// User-triggered calendar resync. Body: `{ accountId?, reason? }`.
// - `view_open`: skipped when the last sync finished under two minutes ago.
//   It does not use the manual rate limit.
// - `pull` and `manual_http`: always sync (forced claim), rate limited.
// Response: `{ ok: true, started, lastSyncedAt, reason }`.

interface CalendarResyncRouteDependencies {
  requireCurrentUser: typeof requireCurrentUser;
  enforceUserRateLimit: typeof enforceUserRateLimit;
  startCalendarResync: typeof startCalendarResync;
}

const defaultDependencies: CalendarResyncRouteDependencies = {
  requireCurrentUser,
  enforceUserRateLimit,
  startCalendarResync,
};

export function createCalendarResyncPost(deps: CalendarResyncRouteDependencies = defaultDependencies) {
  return async function calendarResyncPost(req: NextRequest) {
    try {
      const user = await deps.requireCurrentUser();
      const body = await req.json().catch(() => ({}));
      const accountId = typeof body?.accountId === 'string' ? body.accountId.trim() : '';
      const reason = body?.reason === undefined ? 'manual_http' : parseCalendarResyncReason(body.reason);
      if (!reason) {
        return NextResponse.json(
          { ok: false, error: `reason must be one of: ${CALENDAR_RESYNC_CLIENT_REASONS.join(', ')}` },
          { status: 400 },
        );
      }
      if (consumesCalendarResyncRateLimit(reason)) {
        await deps.enforceUserRateLimit({
          userId: user.userId,
          key: 'calendar_resync',
          limit: 10,
          windowMs: 10 * 60_000,
        });
      }
      const outcome = await deps.startCalendarResync({
        userId: user.userId,
        accountId: accountId || undefined,
        reason,
      });
      return NextResponse.json({
        ok: true,
        started: outcome.started,
        lastSyncedAt: outcome.lastSyncedAt,
        reason,
      });
    } catch (err: any) {
      if (err instanceof RateLimitError) return rateLimitJson(err);
      if (err instanceof AuthRequiredError) {
        return NextResponse.json({ ok: false, error: err.message }, { status: 401 });
      }
      return NextResponse.json({ ok: false, error: err?.message || 'Resync failed.' }, { status: 500 });
    }
  };
}

export const POST = createCalendarResyncPost();
