import { type NextRequest, NextResponse } from 'next/server';
import { isInternalCronRequest } from '@/lib/cron-auth';
import { isStagingRuntime } from '@/lib/hosted/controls';
import { api, convexQuery } from '@/lib/hosted/convex';
import { enqueueBriefJob } from '@/lib/mail/brief-jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Called by the Convex hourly cron (convex/dailyReports.ts) at each user's
// local morning hour, alongside the Daily Brief: every active area's living
// brief is rewritten from the latest Work, mail, calendar, and task context.
// force skips the unchanged-revision short-circuit — mornings always rewrite.
// The 3-hourly refresh cron posts force:false, so an area whose bounded
// context has not changed costs one query and no model call.
export async function POST(req: NextRequest) {
  if (!isInternalCronRequest(req)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized.' }, { status: 401 });
  }
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host');
  if (isStagingRuntime(host)) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'staging' }, { status: 200 });
  }
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    // empty/invalid body handled below
  }
  const userId = String(body?.userId || '').trim();
  const force = body?.force !== false;
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'userId is required.' }, { status: 400 });
  }
  try {
    const areas = await convexQuery<any[]>((api as any).albatross.listAreas, {
      userId,
      status: 'active',
    });
    const jobs = [];
    for (const area of areas)
      jobs.push(
        await enqueueBriefJob({
          userId,
          kind: 'area',
          areaId: String(area._id),
          force,
        }),
      );
    return NextResponse.json({ ok: true, userId, force, areas: areas.length, jobs }, { status: 202 });
  } catch (err: any) {
    console.error('[cron/area-briefs] regeneration failed', userId, err);
    return NextResponse.json(
      { ok: false, error: err?.message || 'area brief regeneration failed', userId },
      { status: 500 },
    );
  }
}
