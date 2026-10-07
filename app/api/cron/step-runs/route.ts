import { type NextRequest, NextResponse } from 'next/server';
import { startAutomaticRuns } from '@/lib/albatross/step-run-start';
import { isInternalCronRequest } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const defaults = { authorized: isInternalCronRequest, start: startAutomaticRuns };

/**
 * The step-run conductor. Convex sends Work the user touched recently; this
 * route checks the switches, the standing order, and each current step, and
 * starts at most one run for each user.
 */
export function createStepRunsCronPost(deps = defaults) {
  return async (request: NextRequest) => {
    if (!deps.authorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await request.json().catch(() => null);
    const candidates: Array<{ userId: string; workId: string }> = Array.isArray(body?.candidates)
      ? body.candidates.filter(
          (row: any) =>
            typeof row?.userId === 'string' && row.userId && typeof row?.workId === 'string' && row.workId,
        )
      : [];
    const byUser = new Map<string, string[]>();
    for (const row of candidates.slice(0, 20))
      byUser.set(row.userId, [...(byUser.get(row.userId) || []), row.workId]);
    let started = 0;
    for (const [userId, workIds] of byUser) {
      const result = await deps.start({ userId, workIds, trigger: 'conductor' }).catch(() => null);
      started += result?.started.length || 0;
    }
    return NextResponse.json({ ok: true, users: byUser.size, started });
  };
}

export const POST = createStepRunsCronPost();
