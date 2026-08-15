import { type NextRequest, NextResponse } from 'next/server';
import { tomorrowWorkPlanStatus } from '@/lib/albatross/checkin';
import { advanceWork } from '@/lib/albatross/work-orchestrator';
import { isInternalCronRequest } from '@/lib/cron-auth';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

interface TomorrowDependencies {
  isInternalCronRequest: typeof isInternalCronRequest;
  convexMutation: typeof convexMutation;
  convexQuery: typeof convexQuery;
  advanceWork: typeof advanceWork;
  reportError: typeof console.error;
}

const defaults: TomorrowDependencies = {
  isInternalCronRequest,
  convexMutation,
  convexQuery,
  advanceWork,
  reportError: console.error,
};

export function createCheckinTomorrowPost(deps: TomorrowDependencies = defaults) {
  return async function POST(req: NextRequest) {
    if (!deps.isInternalCronRequest(req)) {
      return NextResponse.json({ ok: false, error: 'Unauthorized.' }, { status: 401 });
    }
    const body = await req.json().catch(() => ({}));
    const userId = String(body?.userId || '').trim();
    const checkinId = String(body?.checkinId || '').trim();
    const tomorrowIntentText = String(body?.tomorrowIntentText || '').trim();
    const timezone = typeof body?.timezone === 'string' ? body.timezone : undefined;
    if (!userId || !checkinId || !tomorrowIntentText) {
      return NextResponse.json(
        { ok: false, error: 'userId, checkinId, and tomorrowIntentText are required.' },
        { status: 400 },
      );
    }

    let workId: string | undefined;
    try {
      const upserted = await deps.convexMutation<any>((api as any).albatrossIntents.createIntent, {
        userId,
        externalId: `checkin:${checkinId}:tomorrow`,
        rawText: tomorrowIntentText,
        source: 'text',
        title: tomorrowIntentText.slice(0, 180),
        replaceRawText: true,
        returnMetadata: true,
      });
      workId = String(upserted?.workId || '');
      if (!workId) throw new Error('Tomorrow Work could not be created.');
      const existing = await deps.convexQuery<any>((api as any).albatrossWorkV2.workDetail, {
        userId,
        workId,
      });
      const existingStatus = tomorrowWorkPlanStatus(existing);
      let status: 'ready' | 'needs_input';
      if (!upserted.changed && existingStatus === 'needs_input') status = 'needs_input';
      else if (!upserted.changed && existingStatus === 'already_applied') status = 'ready';
      else {
        const planned = await deps.advanceWork({ userId, workId, timezone });
        status = planned.status === 'needs_input' ? 'needs_input' : 'ready';
      }
      await deps.convexMutation((api as any).albatrossNotifications.completeTomorrowPlan, {
        userId,
        checkinId,
        workId,
        status,
      });
      return NextResponse.json({ ok: true, checkinId, workId, status });
    } catch (error) {
      deps.reportError('[cron/checkin-tomorrow] planning failed', checkinId, workId, error);
      await deps
        .convexMutation((api as any).albatrossNotifications.failTomorrowPlan, {
          userId,
          checkinId,
          ...(workId ? { workId } : {}),
          error: 'Tomorrow planning is temporarily unavailable.',
        })
        .catch(() => undefined);
      return NextResponse.json(
        { ok: false, error: 'Tomorrow planning failed.', checkinId, ...(workId ? { workId } : {}) },
        { status: 500 },
      );
    }
  };
}

export const POST = createCheckinTomorrowPost();
