import type { NextRequest } from 'next/server';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation } from '@/lib/hosted/convex';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const allowed = new Set(['active', 'paused', 'done', 'archived']);

export async function POST(req: NextRequest, context: { params: Promise<{ workId: string }> }) {
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'albatross-work-state',
      limit: 60,
      windowMs: 60_000,
    });
    const { workId } = await context.params;
    const body = await req.json().catch(() => ({}));
    const state = String(body?.state || '');
    if (!allowed.has(state)) {
      return Response.json({ ok: false, error: 'invalid state' }, { status: 400 });
    }
    const result = await convexMutation<any>((api as any).albatrossWorkV2.updateWorkState, {
      userId: user.userId,
      workId,
      state,
    });
    return Response.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof RateLimitError) return rateLimitResponse(error);
    const status = error instanceof AuthRequiredError ? 401 : 500;
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : 'state update failed' },
      { status },
    );
  }
}
