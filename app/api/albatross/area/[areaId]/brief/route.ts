import type { NextRequest } from 'next/server';
import type { generateAreaLivingBrief } from '@/lib/albatross/area-living-brief';
import { AuthRequiredError, type CurrentUser, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { enqueueBriefJob, waitForBriefJob } from '@/lib/mail/brief-jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

class AreaBriefNotFoundError extends Error {}

interface AreaBriefRouteDependencies {
  currentUser: () => Promise<CurrentUser>;
  areaExists: (userId: string, areaId: string) => Promise<boolean>;
  reindex: (userId: string, areaId: string) => Promise<unknown>;
  generate: (
    input: Parameters<typeof generateAreaLivingBrief>[0],
    signal?: AbortSignal,
  ) => ReturnType<typeof generateAreaLivingBrief>;
  warn: (message: string, error: unknown) => void;
  error: (message: string, error: unknown) => void;
}

// A small dependency seam keeps the route's security, sequencing, and error
// contract executable in tests without importing Clerk or reaching Convex.
export function createAreaBriefPost(deps: AreaBriefRouteDependencies) {
  return async function areaBriefPost(_req: NextRequest, context: { params: Promise<{ areaId: string }> }) {
    try {
      const user = await deps.currentUser();
      const { areaId } = await context.params;
      if (!areaId) return Response.json({ ok: false, error: 'area required' }, { status: 400 });

      // Confirm ownership explicitly. Brief generation may fail for many
      // unrelated reasons, so the route never guesses "not found" from an
      // arbitrary downstream error message.
      if (!(await deps.areaExists(user.userId, areaId))) throw new AreaBriefNotFoundError();

      // Reindex first so the prose is written from the freshest evidence. A
      // filing failure is best-effort: the existing evidence can still produce
      // a useful brief and the refresh request should not be discarded.
      try {
        await deps.reindex(user.userId, areaId);
      } catch (error: unknown) {
        deps.warn('[albatross-area-brief] evidence reindex failed', error);
      }

      const brief = await deps.generate(
        {
          userId: user.userId,
          userEmail: user.email,
          userName: user.name,
          areaId,
          // A user pressing refresh asks for a new creative edition even if the
          // bounded source revision is unchanged.
          force: true,
        },
        _req.signal,
      );
      return Response.json({ ok: true, brief });
    } catch (error) {
      if (error instanceof AuthRequiredError) {
        return Response.json({ ok: false, error: 'auth required' }, { status: 401 });
      }
      if (error instanceof AreaBriefNotFoundError) {
        return Response.json({ ok: false, error: 'area not found' }, { status: 404 });
      }
      deps.error('[albatross-area-brief] refresh failed', error);
      return Response.json({ ok: false, error: 'brief refresh failed' }, { status: 500 });
    }
  };
}

export const POST = createAreaBriefPost({
  currentUser: requireCurrentUser,
  areaExists: async (userId, areaId) => {
    const area = await convexQuery(api.albatross.areaBriefTarget, { userId, areaId });
    return area !== null;
  },
  reindex: (userId, areaId) =>
    convexMutation(api.albatross.reindexMyAreas, {
      userId,
      areaId,
    }),
  generate: async ({ userId, areaId, force }, signal) => {
    const job = await enqueueBriefJob({ userId, kind: 'area', areaId, force });
    await waitForBriefJob(userId, job.jobId, signal);
    const home = await convexQuery<any>(api.albatross.areaHome, { userId, areaId }, signal);
    return home.livingBrief;
  },
  warn: console.warn,
  error: console.error,
});
