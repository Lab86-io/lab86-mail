import type { NextRequest } from 'next/server';
import { generateAreaLivingBrief } from '@/lib/albatross/area-living-brief';
import { AuthRequiredError, type CurrentUser, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

class AreaBriefNotFoundError extends Error {}

interface AreaBriefRouteDependencies {
  currentUser: () => Promise<CurrentUser>;
  rateLimit: typeof enforceUserRateLimit;
  areaExists: (userId: string, areaId: string) => Promise<boolean>;
  reindex: (userId: string, areaId: string) => Promise<unknown>;
  generate: typeof generateAreaLivingBrief;
}

// A small dependency seam keeps the route's security, sequencing, and error
// contract executable in tests without importing Clerk or reaching Convex.
export function createAreaBriefPost(deps: AreaBriefRouteDependencies) {
  return async function areaBriefPost(_req: NextRequest, context: { params: Promise<{ areaId: string }> }) {
    try {
      const user = await deps.currentUser();
      await deps.rateLimit({
        userId: user.userId,
        key: 'albatross-area-brief',
        limit: 12,
        windowMs: 60_000,
      });
      const { areaId } = await context.params;
      if (!areaId) return Response.json({ ok: false, error: 'area required' }, { status: 400 });

      // Confirm ownership explicitly. Brief generation may fail for many
      // unrelated reasons, so the route never guesses "not found" from an
      // arbitrary downstream error message.
      if (!(await deps.areaExists(user.userId, areaId))) throw new AreaBriefNotFoundError();

      // Reindex first so the prose is written from the freshest evidence. A
      // filing failure is best-effort: the existing evidence can still produce
      // a useful brief and the refresh request should not be discarded.
      await deps.reindex(user.userId, areaId).catch((error: unknown) => {
        console.warn('[albatross-area-brief] evidence reindex failed', error);
      });

      const brief = await deps.generate({
        userId: user.userId,
        userEmail: user.email,
        userName: user.name,
        areaId,
      });
      return Response.json({ ok: true, brief });
    } catch (error) {
      if (error instanceof RateLimitError) return rateLimitResponse(error);
      if (error instanceof AuthRequiredError) {
        return Response.json({ ok: false, error: 'auth required' }, { status: 401 });
      }
      if (error instanceof AreaBriefNotFoundError) {
        return Response.json({ ok: false, error: 'area not found' }, { status: 404 });
      }
      console.error('[albatross-area-brief] refresh failed', error);
      return Response.json({ ok: false, error: 'brief refresh failed' }, { status: 500 });
    }
  };
}

export const POST = createAreaBriefPost({
  currentUser: requireCurrentUser,
  rateLimit: enforceUserRateLimit,
  areaExists: async (userId, areaId) => {
    const areas = await convexQuery<any[]>((api as any).albatross.listAreas, { userId });
    return areas.some((area) => String(area._id) === areaId);
  },
  reindex: (userId, areaId) =>
    convexMutation((api as any).albatross.reindexMyAreas, {
      userId,
      areaId,
    }),
  generate: generateAreaLivingBrief,
});
