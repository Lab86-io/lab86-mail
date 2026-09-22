import { type NextRequest, NextResponse } from 'next/server';
import { isInternalCronRequest } from '@/lib/cron-auth';
import { isStagingRuntime } from '@/lib/hosted/controls';
import { enqueueBriefJob } from '@/lib/mail/brief-jobs';

export {
  BRIEF_NOTIFICATION_BODY_MAX,
  briefNotificationBody,
  localDateForTimezone,
} from '@/lib/mail/brief-ready';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const defaults = { isInternalCronRequest, isStagingRuntime, enqueue: enqueueBriefJob };
export function createDailyReportPost(deps = defaults) {
  return async function post(req: NextRequest) {
    if (!deps.isInternalCronRequest(req))
      return NextResponse.json({ ok: false, error: 'Unauthorized.' }, { status: 401 });
    if (deps.isStagingRuntime(req.headers.get('x-forwarded-host') || req.headers.get('host')))
      return NextResponse.json({ ok: true, skipped: true, reason: 'staging' });
    const body = await req.json().catch(() => null);
    const userId = typeof body?.userId === 'string' ? body.userId.trim() : '';
    if (!userId) return NextResponse.json({ ok: false, error: 'userId is required.' }, { status: 400 });
    const kind = body?.kind === 'morning' || body?.kind === 'evening' ? body.kind : 'manual';
    try {
      const job = await deps.enqueue({
        userId,
        kind: 'daily',
        edition: kind,
        timezone: typeof body?.timezone === 'string' ? body.timezone : undefined,
      });
      return NextResponse.json({ ok: true, userId, kind, ...job }, { status: 202 });
    } catch {
      return NextResponse.json({ ok: false, error: 'Could not queue the daily brief.' }, { status: 500 });
    }
  };
}
export const POST = createDailyReportPost();
