import type { NextRequest } from 'next/server';
import { generateAreaLivingBrief } from '@/lib/albatross/area-living-brief';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation } from '@/lib/hosted/convex';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(_req: NextRequest, context: { params: Promise<{ areaId: string }> }) {
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'albatross-area-brief',
      limit: 12,
      windowMs: 60_000,
    });
    const { areaId } = await context.params;
    if (!areaId) return Response.json({ ok: false, error: 'area required' }, { status: 400 });

    const [brief] = await Promise.all([
      generateAreaLivingBrief({
        userId: user.userId,
        userEmail: user.email,
        userName: user.name,
        areaId,
      }),
      convexMutation((api as any).albatross.reindexMyAreas, {
        userId: user.userId,
        areaId,
      }),
    ]);
    return Response.json({ ok: true, brief });
  } catch (error) {
    if (error instanceof RateLimitError) return rateLimitResponse(error);
    if (error instanceof AuthRequiredError) {
      return Response.json({ ok: false, error: 'auth required' }, { status: 401 });
    }
    const message = error instanceof Error ? error.message : 'brief refresh failed';
    const status = /not found/i.test(message) ? 404 : 500;
    return Response.json({ ok: false, error: message }, { status });
  }
}
