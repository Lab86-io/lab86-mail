import type { NextRequest } from 'next/server';
import { answerFromForm } from '@/lib/albatross/form-answer-route';
import { resumeRunForAnswer } from '@/lib/albatross/step-run-start';
import { advanceWork } from '@/lib/albatross/work-orchestrator';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation } from '@/lib/hosted/convex';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '@/lib/rate-limit';
import { errorAnswerMessage } from '@/lib/security/error-answer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(req: NextRequest, context: { params: Promise<{ questionId: string }> }) {
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'albatross-work-answer',
      limit: 60,
      windowMs: 60_000,
    });
    const { questionId } = await context.params;
    const body = await req.json();
    let answer = String(body.answer || '').trim();
    let answeredOptionId = typeof body.answeredOptionId === 'string' ? body.answeredOptionId : undefined;
    // A whole form (docs/albatross-thread.md, "Questions are forms").
    if (body.form && typeof body.form === 'object') {
      const result = await answerFromForm(
        { userId: user.userId, name: user.name, email: user.email },
        questionId,
        body.form,
      );
      if (!result.ok)
        return Response.json(
          { ok: false, error: result.error, errors: result.errors },
          { status: result.status },
        );
      answer = result.answer;
      answeredOptionId = result.answeredOptionId;
    }
    if (!answer) return Response.json({ ok: false, error: 'answer required' }, { status: 400 });
    const answered = await convexMutation<{
      workId?: string;
      projectId?: string;
      routineId?: string;
      shouldAdvance: boolean;
    }>(api.albatrossWorkV2.answerQuestion, {
      userId: user.userId,
      questionId,
      answer,
      answeredOptionId,
    });
    // A step run that asked this question continues with the answer. The
    // run owns the step now, so the plan does not move under it.
    if (answered.workId) {
      const runId = await resumeRunForAnswer({
        userId: user.userId,
        workId: answered.workId,
        questionId,
        answer,
      }).catch(() => null);
      if (runId) return Response.json({ ok: true, status: 'answered', ...answered, runId });
    }
    if (answered.shouldAdvance && answered.workId) {
      const result = await advanceWork({
        userId: user.userId,
        userEmail: user.email,
        userName: user.name,
        workId: answered.workId,
        timezone: typeof body.timezone === 'string' ? body.timezone : undefined,
      });
      return Response.json({ ok: true, ...answered, ...result });
    }
    return Response.json({ ok: true, status: 'answered', ...answered });
  } catch (error) {
    if (error instanceof RateLimitError) return rateLimitResponse(error);
    const status = error instanceof AuthRequiredError ? 401 : 500;
    return Response.json(
      {
        ok: false,
        error: errorAnswerMessage(status, error, 'answer failed', '[albatross/work/answer] failed'),
      },
      { status },
    );
  }
}
