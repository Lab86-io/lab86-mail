import { type NextRequest, NextResponse } from 'next/server';
import { runWithAiRequestContext } from '@/lib/ai/context';
import {
  planShapeBackfill,
  SHAPE_BACKFILL_BATCH,
  type UnshapedWorkRow,
} from '@/lib/albatross/shape-backfill';
import { isInternalCronRequest } from '@/lib/cron-auth';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// One pass of the shape backfill for one user. Work captured before shapes
// existed reads as `quick`, so it is planned, watched, and reviewed. This
// route gives each row the shape it always had.
//
// The pass is bounded and repeatable. Every run reads only Work that still
// has no shape, so running it twice is safe and the second run does less.

export interface ShapeBackfillDeps {
  isInternalCronRequest: (request: NextRequest) => boolean;
  listUnshaped: (input: { userId: string; limit: number }) => Promise<UnshapedWorkRow[]>;
  applyWrite: (input: Record<string, unknown>) => Promise<unknown>;
  plan: typeof planShapeBackfill;
}

const defaultDeps: ShapeBackfillDeps = {
  isInternalCronRequest,
  listUnshaped: ({ userId, limit }) =>
    convexQuery((api as any).albatrossWorkV2.unshapedWork, { userId, limit }) as Promise<UnshapedWorkRow[]>,
  applyWrite: (input) => convexMutation((api as any).albatrossWorkV2.applyShapeBackfill, input),
  plan: planShapeBackfill,
};

export function createShapeBackfillPost(deps: ShapeBackfillDeps = defaultDeps) {
  return async function POST(req: NextRequest) {
    if (!deps.isInternalCronRequest(req)) {
      return NextResponse.json({ ok: false, error: 'Unauthorized.' }, { status: 401 });
    }
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      // An empty body is answered below.
    }
    const userId = String(body?.userId || '').trim();
    if (!userId) {
      return NextResponse.json({ ok: false, error: 'userId is required.' }, { status: 400 });
    }
    const limit = Math.max(1, Math.min(Number(body?.limit) || SHAPE_BACKFILL_BATCH, 200));

    try {
      const rows = await deps.listUnshaped({ userId, limit });
      if (!rows.length) {
        return NextResponse.json({ ok: true, userId, read: 0, written: 0, remaining: 0 });
      }
      const writes = await runWithAiRequestContext({ userId, agent: 'ai' }, () => deps.plan(rows));
      const byShape: Record<string, number> = {};
      let written = 0;
      for (const write of writes) {
        try {
          await deps.applyWrite({ userId, ...write });
          byShape[write.shape] = (byShape[write.shape] || 0) + 1;
          written += 1;
        } catch (error) {
          console.error('[cron/shape-backfill] write failed', write.workId, error);
        }
      }
      // A full batch means there is probably more to read on the next pass.
      const remaining = rows.length === limit ? 'more' : 0;
      return NextResponse.json({ ok: true, userId, read: rows.length, written, byShape, remaining });
    } catch (err: any) {
      console.error('[cron/shape-backfill] backfill failed', userId, err);
      return NextResponse.json(
        { ok: false, error: err?.message || 'shape backfill failed', userId },
        { status: 500 },
      );
    }
  };
}

export const POST = createShapeBackfillPost();
