import { type NextRequest, NextResponse } from 'next/server';
import { tomorrowWorkPlanStatus } from '@/lib/albatross/checkin';
import {
  splitTomorrowWork,
  tomorrowExternalId,
  tomorrowExternalPrefix,
} from '@/lib/albatross/tomorrow-split';
import { advanceWork } from '@/lib/albatross/work-orchestrator';
import { isInternalCronRequest } from '@/lib/cron-auth';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Planning stops at this budget. The work conductor advances the rest. */
const PLAN_BUDGET_MS = 230_000;

interface TomorrowDependencies {
  isInternalCronRequest: typeof isInternalCronRequest;
  convexMutation: typeof convexMutation;
  convexQuery: typeof convexQuery;
  advanceWork: typeof advanceWork;
  splitTomorrow: typeof splitTomorrowWork;
  reportError: typeof console.error;
  nowMs: () => number;
}

const defaults: TomorrowDependencies = {
  isInternalCronRequest,
  convexMutation,
  convexQuery,
  advanceWork,
  splitTomorrow: splitTomorrowWork,
  reportError: console.error,
  nowMs: () => Date.now(),
};

export function createCheckinTomorrowPost(overrides: Partial<TomorrowDependencies> = {}) {
  const deps: TomorrowDependencies = { ...defaults, ...overrides };
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

    const workIds: string[] = [];
    try {
      // One answer holds many independent outcomes. Reconcile the split
      // against the Works an earlier save of this check-in created.
      const prefix = tomorrowExternalPrefix(checkinId);
      const existingRows =
        (await deps
          .convexQuery<any[]>((api as any).albatrossIntents.listByExternalPrefix, { userId, prefix })
          .catch(() => [])) || [];
      const existing = existingRows.map((row) => ({
        workId: String(row._id),
        title: String(row.title || ''),
        started: Boolean(row.started),
        workState: String(row.workState || 'active'),
        externalId: typeof row.externalId === 'string' ? row.externalId : null,
      }));

      const split = await deps.splitTomorrow({
        userId,
        tomorrowIntentText,
        existing: existing.map(({ workId, title, started }) => ({ workId, title, started })),
      });

      const taken = new Set(existing.map((row) => row.externalId).filter((id): id is string => Boolean(id)));
      const kept = new Set<string>();
      const planTargets: string[] = [];
      let needsInput = false;

      for (const item of split.items) {
        if (item.existingWorkId) {
          kept.add(item.existingWorkId);
          workIds.push(item.existingWorkId);
          continue;
        }
        const externalId = split.fallback ? prefix : tomorrowExternalId(checkinId, item.title, taken);
        taken.add(externalId);
        const upserted = await deps.convexMutation<any>((api as any).albatrossIntents.createIntent, {
          userId,
          externalId,
          rawText: item.rawText,
          source: 'text',
          title: item.title.slice(0, 180),
          replaceRawText: true,
          returnMetadata: true,
        });
        const workId = String(upserted?.workId || '');
        if (!workId) throw new Error('Tomorrow Work could not be created.');
        kept.add(workId);
        workIds.push(workId);
        if (upserted?.changed === false) {
          const detail = await deps
            .convexQuery<any>((api as any).albatrossWorkV2.workDetail, { userId, workId })
            .catch(() => null);
          const existingStatus = tomorrowWorkPlanStatus(detail);
          if (existingStatus === 'needs_input') needsInput = true;
          if (existingStatus !== 'advance') continue;
        }
        planTargets.push(workId);
      }

      // A sibling the new answer no longer names is released, and only while
      // nothing has happened to it. Started work is never removed here.
      for (const row of existing) {
        if (kept.has(row.workId) || row.started || row.workState !== 'active') continue;
        await deps
          .convexMutation((api as any).albatrossWorkV2.releaseUnstartedWork, {
            userId,
            workId: row.workId,
            reason: 'The revised check-in plan replaced this Work.',
          })
          .catch(() => undefined);
      }

      const deadline = deps.nowMs() + PLAN_BUDGET_MS;
      for (const workId of planTargets) {
        if (deps.nowMs() > deadline) break;
        const planned = await deps.advanceWork({ userId, workId, timezone });
        if (planned.status === 'needs_input') needsInput = true;
      }

      const status: 'ready' | 'needs_input' = needsInput ? 'needs_input' : 'ready';
      await deps.convexMutation((api as any).albatrossNotifications.completeTomorrowPlan, {
        userId,
        checkinId,
        workId: workIds[0],
        workIds,
        status,
      });
      return NextResponse.json({ ok: true, checkinId, workId: workIds[0], workIds, status });
    } catch (error) {
      deps.reportError('[cron/checkin-tomorrow] planning failed', checkinId, workIds[0], error);
      await deps
        .convexMutation((api as any).albatrossNotifications.failTomorrowPlan, {
          userId,
          checkinId,
          ...(workIds[0] ? { workId: workIds[0] } : {}),
          error: 'Tomorrow planning is temporarily unavailable.',
        })
        .catch(() => undefined);
      return NextResponse.json(
        {
          ok: false,
          error: 'Tomorrow planning failed.',
          checkinId,
          ...(workIds[0] ? { workId: workIds[0] } : {}),
        },
        { status: 500 },
      );
    }
  };
}

export const POST = createCheckinTomorrowPost();
