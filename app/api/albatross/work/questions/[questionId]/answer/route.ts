import type { NextRequest } from 'next/server';
import { advanceWork } from '@/lib/albatross/work-orchestrator';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation } from '@/lib/hosted/convex';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '@/lib/rate-limit';

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
    const answer = String(body.answer || '').trim();
    if (!answer) return Response.json({ ok: false, error: 'answer required' }, { status: 400 });
    const workId = await convexMutation<string>((api as any).albatrossWorkV2.answerQuestion, {
      userId: user.userId,
      questionId,
      answer,
      answeredOptionId: typeof body.answeredOptionId === 'string' ? body.answeredOptionId : undefined,
    });
    const result = await advanceWork({
      userId: user.userId,
      userEmail: user.email,
      userName: user.name,
      workId,
      timezone: typeof body.timezone === 'string' ? body.timezone : undefined,
    });
    return Response.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof RateLimitError) return rateLimitResponse(error);
    const status = error instanceof AuthRequiredError ? 401 : 500;
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : 'answer failed' },
      { status },
    );
  }
}
