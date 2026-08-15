import type { NextRequest } from 'next/server';
import { completeWorkStep, StepExecutionError } from '@/lib/albatross/step-execution';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(req: NextRequest, context: { params: Promise<{ workId: string }> }) {
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'albatross-work-step',
      limit: 60,
      windowMs: 60_000,
    });
    const { workId } = await context.params;
    const body = await req.json().catch(() => ({}));
    const result = await completeWorkStep({
      userId: user.userId,
      userEmail: user.email,
      userName: user.name,
      workId,
      stepKey: typeof body.stepKey === 'string' ? body.stepKey : undefined,
      timezone: typeof body.timezone === 'string' ? body.timezone : undefined,
    });
    return Response.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof RateLimitError) return rateLimitResponse(error);
    const status =
      error instanceof AuthRequiredError ? 401 : error instanceof StepExecutionError ? error.status : 500;
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : 'Step update failed.' },
      { status },
    );
  }
}
