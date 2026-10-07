import { after, type NextRequest, NextResponse } from 'next/server';
import { runStepRun } from '@/lib/albatross/step-runner';
import { isInternalCronRequest } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const defaults = { authorized: isInternalCronRequest, after, run: runStepRun };

/**
 * Convex delivers one queued step run here. The request only acknowledges the
 * durable run; the run works after the response, under its own lease.
 */
export function createStepRunJobPost(deps = defaults) {
  return async (request: NextRequest) => {
    if (!deps.authorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await request.json().catch(() => null);
    if (typeof body?.userId !== 'string' || !body.userId || typeof body?.id !== 'string' || !body.id)
      return NextResponse.json({ error: 'Run required' }, { status: 400 });
    deps.after(async () => {
      await deps.run(body.userId, body.id).catch((error: unknown) => {
        console.error('[cron/step-run] run crashed', body.id, error instanceof Error ? error.name : 'error');
      });
    });
    return NextResponse.json({ accepted: true }, { status: 202 });
  };
}

export const POST = createStepRunJobPost();
