import { type NextRequest, NextResponse } from 'next/server';
import { generateIntentPlan } from '@/lib/albatross/intent-plan';
import { isInternalCronRequest } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/* Called by the Convex plan-reconcile cron (convex/albatrossIntents.ts
 * planReconcileTick) for one stale 'planning' intent. Re-runs the full
 * generation server-side; generateIntentPlan owns status transitions and
 * writes planError on failure, so this route just reports the outcome.
 * The retry has no browser context — geo/timezone are simply omitted. */
export async function POST(req: NextRequest) {
  if (!isInternalCronRequest(req)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized.' }, { status: 401 });
  }
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    // handled below
  }
  const userId = String(body?.userId || '').trim();
  const intentId = String(body?.intentId || '').trim();
  if (!userId || !intentId) {
    return NextResponse.json({ ok: false, error: 'userId and intentId are required.' }, { status: 400 });
  }
  try {
    await generateIntentPlan({ userId, intentId });
    return NextResponse.json({ ok: true, userId, intentId }, { status: 200 });
  } catch (err: any) {
    console.error('[cron/plan-reconcile] regeneration failed', intentId, err);
    return NextResponse.json(
      { ok: false, error: err?.message || 'plan regeneration failed', intentId },
      { status: 500 },
    );
  }
}
