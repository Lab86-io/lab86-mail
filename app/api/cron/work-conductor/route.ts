import { type NextRequest, NextResponse } from 'next/server';
import { advanceWork } from '@/lib/albatross/work-orchestrator';
import { isInternalCronRequest } from '@/lib/cron-auth';
import { resolveBriefTimezone } from '@/lib/mail/brief-timezone';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

interface WorkConductorDependencies {
  isInternalCronRequest: typeof isInternalCronRequest;
  advanceWork: typeof advanceWork;
  resolveTimezone: typeof resolveBriefTimezone;
  reportError: typeof console.error;
}

const defaults: WorkConductorDependencies = {
  isInternalCronRequest,
  advanceWork,
  resolveTimezone: resolveBriefTimezone,
  reportError: console.error,
};

export function createWorkConductorPost(deps: WorkConductorDependencies = defaults) {
  return async function POST(req: NextRequest) {
    if (!deps.isInternalCronRequest(req)) {
      return NextResponse.json({ ok: false, error: 'Unauthorized.' }, { status: 401 });
    }
    const body = await req.json().catch(() => ({}));
    const userId = String(body?.userId || '').trim();
    const workId = String(body?.workId || '').trim();
    if (!userId || !workId) {
      return NextResponse.json({ ok: false, error: 'userId and workId are required.' }, { status: 400 });
    }
    try {
      // Without a zone the planner reads the work hours in UTC. The cron has
      // no browser zone, so the stored zone order (Settings, calendar, last
      // client) applies, as for the scheduled briefs.
      const timezone = await deps.resolveTimezone(userId, undefined);
      const result = await deps.advanceWork({ userId, workId, trigger: 'conductor', timezone });
      return NextResponse.json({ ok: true, ...result });
    } catch (error) {
      deps.reportError('[cron/work-conductor] advance failed', workId, error);
      return NextResponse.json(
        { ok: false, error: error instanceof Error ? error.message : 'advance failed', workId },
        { status: 500 },
      );
    }
  };
}

export const POST = createWorkConductorPost();
