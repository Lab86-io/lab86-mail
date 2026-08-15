import type { NextRequest } from 'next/server';
import { type Recovery, recoveryWorkState, shrinkSuggestion } from '@/lib/albatross/forgiveness';
import { completeWorkStep } from '@/lib/albatross/step-execution';
import { advanceWork } from '@/lib/albatross/work-orchestrator';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

interface WorkRecoveryDependencies {
  requireCurrentUser: typeof requireCurrentUser;
  enforceUserRateLimit: typeof enforceUserRateLimit;
  convexMutation: typeof convexMutation;
  convexQuery: typeof convexQuery;
  completeWorkStep: typeof completeWorkStep;
  advanceWork: typeof advanceWork;
}

const defaults: WorkRecoveryDependencies = {
  requireCurrentUser,
  enforceUserRateLimit,
  convexMutation,
  convexQuery,
  completeWorkStep,
  advanceWork,
};

const recoveries = new Set<Recovery>([
  'done',
  'move',
  'shrink',
  'wait',
  'delegate',
  'pause',
  'release',
  'rebuild',
]);

export function createWorkRecoveryPost(deps: WorkRecoveryDependencies = defaults) {
  return async function POST(req: NextRequest, context: { params: Promise<{ workId: string }> }) {
    try {
      const user = await deps.requireCurrentUser();
      await deps.enforceUserRateLimit({
        userId: user.userId,
        key: 'albatross-work-recover',
        limit: 30,
        windowMs: 60_000,
      });
      const { workId } = await context.params;
      const body = await req.json().catch(() => ({}));
      if (typeof body.recovery !== 'string' || !recoveries.has(body.recovery as Recovery)) {
        return Response.json({ ok: false, error: 'Invalid recovery.' }, { status: 400 });
      }
      const detail = await deps.convexQuery<any>((api as any).albatrossWorkV2.workDetail, {
        userId: user.userId,
        workId,
      });
      if (!detail?.work) {
        return Response.json({ ok: false, error: 'Albatross Work not found.' }, { status: 404 });
      }
      const step = (detail?.execution?.guideSteps || []).find(
        (row: any) => row.key === (body.stepKey || detail?.execution?.currentStep?.key),
      );
      const recovery = body.recovery as Recovery;
      const revisedStep = recovery === 'shrink' ? shrinkSuggestion(step?.title) : undefined;
      await deps.convexMutation((api as any).albatrossWorkV2.recordLapse, {
        userId: user.userId,
        workId,
        stepKey: step?.key,
        stepTitle: step?.title,
        plannedAt: typeof body.plannedAt === 'number' ? body.plannedAt : undefined,
        reasonKind: typeof body.reasonKind === 'string' ? body.reasonKind : 'other',
        reasonSource: 'user',
        recovery,
        revisedStep,
      });

      if (recovery === 'done') {
        const completed = await deps.completeWorkStep({
          userId: user.userId,
          userEmail: user.email,
          userName: user.name,
          workId,
          stepKey: step?.key,
          timezone: typeof body.timezone === 'string' ? body.timezone : undefined,
        });
        return Response.json({ ok: true, recovery, ...completed });
      }
      const recoveryState = recoveryWorkState(recovery);
      if (recoveryState === 'waiting' || recoveryState === 'paused') {
        await deps.convexMutation((api as any).albatrossWorkV2.updateWorkState, {
          userId: user.userId,
          workId,
          state: recoveryState,
        });
        return Response.json({ ok: true, recovery, state: recoveryState, replanned: false, revisedStep });
      }
      if (recoveryState === 'released') {
        await deps.convexMutation((api as any).albatrossWorkV2.releaseWork, {
          userId: user.userId,
          workId,
          reason: 'This no longer deserves space after its planned block passed.',
        });
        return Response.json({ ok: true, recovery, state: 'released', replanned: false, revisedStep });
      }
      // `done`, waiting, paused, and released return above. Every remaining
      // accepted recovery keeps the Work active and therefore needs a new plan.
      await deps.advanceWork({
        userId: user.userId,
        userEmail: user.email,
        userName: user.name,
        workId,
        timezone: typeof body.timezone === 'string' ? body.timezone : undefined,
      });
      return Response.json({ ok: true, recovery, replanned: true, revisedStep });
    } catch (error) {
      if (error instanceof RateLimitError) return rateLimitResponse(error);
      const status = error instanceof AuthRequiredError ? 401 : 500;
      return Response.json(
        { ok: false, error: error instanceof Error ? error.message : 'Recovery failed.' },
        { status },
      );
    }
  };
}

export const POST = createWorkRecoveryPost();
