import { type NextRequest, NextResponse } from 'next/server';
import { runWithAiRequestContext } from '@/lib/ai/context';
import { generateAreaLivingBrief } from '@/lib/albatross/area-living-brief';
import { isInternalCronRequest } from '@/lib/cron-auth';
import { isStagingRuntime } from '@/lib/hosted/controls';
import { api, convexQuery } from '@/lib/hosted/convex';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// One fast-model call per active area; a user with many areas still finishes
// well inside this ceiling because briefs regenerate sequentially.
export const maxDuration = 300;

// Called by the Convex hourly cron (convex/dailyReports.ts) at each user's
// local morning hour, alongside the Daily Brief: every active area's living
// brief is rewritten from the latest Work, mail, calendar, and task context.
// force skips the unchanged-revision short-circuit — mornings always rewrite.
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
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'userId is required.' }, { status: 400 });
  }
  try {
    const areas = await convexQuery<any[]>((api as any).albatross.listAreas, {
      userId,
      status: 'active',
    });
    let refreshed = 0;
    const errors: Array<{ areaId: string; error: string }> = [];
    await runWithAiRequestContext({ userId, agent: 'ai' }, async () => {
      for (const area of areas) {
        try {
          await generateAreaLivingBrief({ userId, areaId: String(area._id), force: true });
          refreshed += 1;
        } catch (err: any) {
          // One area failing (model hiccup, empty context) must not stop the
          // rest of the morning's briefs.
          errors.push({ areaId: String(area._id), error: err?.message || 'brief generation failed' });
        }
      }
    });
    return NextResponse.json({ ok: true, userId, areas: areas.length, refreshed, errors }, { status: 200 });
  } catch (err: any) {
    console.error('[cron/area-briefs] regeneration failed', userId, err);
    return NextResponse.json(
      { ok: false, error: err?.message || 'area brief regeneration failed', userId },
      { status: 500 },
    );
  }
}
