import { buildThreadRows, type ThreadActivity, type ThreadWorkInput } from '@/lib/albatross/threads';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexQuery } from '@/lib/hosted/convex';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '@/lib/rate-limit';
import { errorAnswerMessage } from '@/lib/security/error-answer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The thread list for the native apps (docs/albatross-threads.md, T1): the
// Work list merged with the live run and reply activity, sorted. Web reads the
// same two Convex queries live and merges with the same function.

const defaults = { requireCurrentUser, enforceUserRateLimit, convexQuery };

export function createThreadsGet(deps = defaults) {
  return async function GET() {
    try {
      const user = await deps.requireCurrentUser();
      // The list polls every 5 s while something works, on several devices.
      await deps.enforceUserRateLimit({
        userId: user.userId,
        key: 'albatross-threads',
        limit: 120,
        windowMs: 60_000,
      });
      const [works, activity] = await Promise.all([
        deps.convexQuery<ThreadWorkInput[]>(api.albatrossWorkV2.allWork, { userId: user.userId, limit: 200 }),
        deps.convexQuery<ThreadActivity>(api.albatrossThreads.activity, { userId: user.userId }),
      ]);
      const threads = buildThreadRows(works || [], activity);
      return Response.json(
        { ok: true, threads, now: activity?.now ?? Date.now() },
        { headers: { 'cache-control': 'no-store' } },
      );
    } catch (error) {
      if (error instanceof RateLimitError) return rateLimitResponse(error);
      const status = error instanceof AuthRequiredError ? 401 : 500;
      return Response.json(
        {
          ok: false,
          error: errorAnswerMessage(status, error, 'Threads did not load.', '[albatross/threads] failed'),
        },
        { status },
      );
    }
  };
}

export const GET = createThreadsGet();
