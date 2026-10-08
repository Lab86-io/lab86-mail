import type { NextRequest } from 'next/server';
import { completeWorkStep, StepExecutionError } from '@/lib/albatross/step-execution';
import { completeStepAndContinue } from '@/lib/albatross/step-run-start';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '@/lib/rate-limit';
import { errorAnswerMessage } from '@/lib/security/error-answer';
import { truncateText } from '@/lib/shared/text';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

interface WorkStepDependencies {
  requireCurrentUser: typeof requireCurrentUser;
  enforceUserRateLimit: typeof enforceUserRateLimit;
  completeWorkStep: typeof completeWorkStep;
  completeStepAndContinue: typeof completeStepAndContinue;
}

const defaults: WorkStepDependencies = {
  requireCurrentUser,
  enforceUserRateLimit,
  completeWorkStep,
  completeStepAndContinue,
};

export function createWorkStepPost(deps: WorkStepDependencies = defaults) {
  return async function POST(req: NextRequest, context: { params: Promise<{ workId: string }> }) {
    try {
      const user = await deps.requireCurrentUser();
      await deps.enforceUserRateLimit({
        userId: user.userId,
        key: 'albatross-work-step',
        limit: 60,
        windowMs: 60_000,
      });
      const { workId } = await context.params;
      const body = await req.json().catch(() => ({}));
      const input = {
        userId: user.userId,
        userEmail: user.email,
        userName: user.name,
        workId,
        stepKey: typeof body.stepKey === 'string' ? body.stepKey : undefined,
        timezone: typeof body.timezone === 'string' ? body.timezone : undefined,
        note: typeof body.note === 'string' ? truncateText(body.note, 2_000) : undefined,
      };
      // `continue`: the user marked a run's result done, and Albatross goes on
      // to the next step it can do (docs/albatross-document-handoff.md).
      if (body.continue === true) {
        const result = await deps.completeStepAndContinue(input);
        return Response.json({ ok: true, ...result });
      }
      const result = await deps.completeWorkStep(input);
      return Response.json({ ok: true, ...result });
    } catch (error) {
      if (error instanceof RateLimitError) return rateLimitResponse(error);
      const status =
        error instanceof AuthRequiredError ? 401 : error instanceof StepExecutionError ? error.status : 500;
      return Response.json(
        {
          ok: false,
          error: errorAnswerMessage(status, error, 'Step update failed.', '[albatross/work/step] failed'),
        },
        { status },
      );
    }
  };
}

export const POST = createWorkStepPost();
