import { type NextRequest, NextResponse } from 'next/server';
import { advanceWork } from '@/lib/albatross/work-orchestrator';
import { isInternalCronRequest } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

interface WorkConductorDependencies {
  isInternalCronRequest: typeof isInternalCronRequest;
  advanceWork: typeof advanceWork;
  reportError: typeof console.error;
}

const defaults: WorkConductorDependencies = {
  isInternalCronRequest,
  advanceWork,
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
      return NextResponse.json(
        { ok: false, error: 'userId and workId are required.' },
        { status: 400 },
      );
    }
    try {
      const result = await deps.advanceWork({ userId, workId });
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
