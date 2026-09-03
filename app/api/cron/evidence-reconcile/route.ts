import { type NextRequest, NextResponse } from 'next/server';
import { advanceWork } from '@/lib/albatross/work-orchestrator';
import { isInternalCronRequest } from '@/lib/cron-auth';
import { api, convexMutation } from '@/lib/hosted/convex';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

interface EvidenceReconcileDependencies {
  isInternalCronRequest: typeof isInternalCronRequest;
  advanceWork: typeof advanceWork;
  convexMutation: typeof convexMutation;
  reportError: typeof console.error;
}

const defaults: EvidenceReconcileDependencies = {
  isInternalCronRequest,
  advanceWork,
  convexMutation,
  reportError: console.error,
};

export function createEvidenceReconcilePost(deps: EvidenceReconcileDependencies = defaults) {
  return async function POST(req: NextRequest) {
    if (!deps.isInternalCronRequest(req)) {
      return NextResponse.json({ ok: false, error: 'Unauthorized.' }, { status: 401 });
    }
    const body = await req.json().catch(() => ({}));
    const userId = String(body?.userId || '').trim();
    const workId = String(body?.workId || '').trim();
    const evidenceAt = body?.evidenceAt;
    if (!userId || !workId || typeof evidenceAt !== 'number' || !Number.isFinite(evidenceAt)) {
      return NextResponse.json(
        { ok: false, error: 'userId, workId, and evidenceAt are required.' },
        { status: 400 },
      );
    }
    try {
      const result = await deps.advanceWork({ userId, workId, trigger: 'evidence' });
      // Dormant Work keeps its unreconciled evidence. The wake makes it a
      // candidate again, and the proof is read then.
      if (result.status !== 'dormant') {
        await deps.convexMutation((api as any).albatrossWorkV2.completeEvidenceReconcile, {
          userId,
          workId,
          evidenceAt,
        });
      }
      return NextResponse.json({ ok: true, workId, status: result.status });
    } catch (error) {
      deps.reportError('[cron/evidence-reconcile] advance failed', workId, error);
      return NextResponse.json(
        { ok: false, error: 'Evidence reconciliation failed.', workId },
        { status: 500 },
      );
    }
  };
}

export const POST = createEvidenceReconcilePost();
