import { type NextRequest, NextResponse } from 'next/server';
import { isInternalCronRequest } from '@/lib/cron-auth';
import { isStagingRuntime } from '@/lib/hosted/controls';
import { isStandingOrderPaused } from '@/lib/hosted/standing-orders';
import { enqueueBriefJob } from '@/lib/mail/brief-jobs';

export {
  BRIEF_NOTIFICATION_BODY_MAX,
  briefNotificationBody,
  localDateForTimezone,
} from '@/lib/mail/brief-ready';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const defaults = {
  isInternalCronRequest,
  isStagingRuntime,
  enqueue: enqueueBriefJob,
  briefPaused: (userId: string) => isStandingOrderPaused(userId, 'brief'),
};
export function createDailyReportPost(overrides: Partial<typeof defaults> = {}) {
  const deps = { ...defaults, ...overrides };
  return async function post(req: NextRequest) {
    if (!deps.isInternalCronRequest(req))
      return NextResponse.json({ ok: false, error: 'Unauthorized.' }, { status: 401 });
    if (deps.isStagingRuntime(req.headers.get('x-forwarded-host') || req.headers.get('host')))
      return NextResponse.json({ ok: true, skipped: true, reason: 'staging' });
    const body = await req.json().catch(() => null);
    const userId = typeof body?.userId === 'string' ? body.userId.trim() : '';
    if (!userId) return NextResponse.json({ ok: false, error: 'userId is required.' }, { status: 400 });
    const kind = body?.kind === 'morning' || body?.kind === 'weekly' ? body.kind : 'manual';
    // Settings, Standing orders: a paused Brief gets no scheduled edition.
    if (kind !== 'manual' && (await deps.briefPaused(userId)))
      return NextResponse.json({ ok: true, skipped: true, reason: 'paused' });
    // A weekend light edition (lib/brief/schedule.ts). Only a morning edition is light.
    const light = kind === 'morning' && body?.light === true;
    try {
      const job = await deps.enqueue({
        userId,
        kind: 'daily',
        edition: kind,
        timezone: typeof body?.timezone === 'string' ? body.timezone : undefined,
        ...(light ? { light: true } : {}),
      });
      return NextResponse.json(
        { ok: true, userId, kind, ...(light ? { light } : {}), ...job },
        { status: 202 },
      );
    } catch {
      return NextResponse.json({ ok: false, error: 'Could not queue the daily brief.' }, { status: 500 });
    }
  };
}
export const POST = createDailyReportPost();
