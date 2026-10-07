import type { NextRequest } from 'next/server';
import type { ThreadRunsResponse } from '@/lib/albatross/thread-contract';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexQuery } from '@/lib/hosted/convex';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '@/lib/rate-limit';
import { errorAnswerMessage } from '@/lib/security/error-answer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The runs of one Work for the thread (docs/albatross-thread.md), oldest
// first, each with the question it asked. Web reads the same rows live from
// Convex; iOS and macOS poll this route while a run is open.

const defaults = { requireCurrentUser, enforceUserRateLimit, convexQuery };

export function createThreadRunsGet(deps = defaults) {
  return async function GET(_req: NextRequest, context: { params: Promise<{ workId: string }> }) {
    try {
      const user = await deps.requireCurrentUser();
      // A poll every 3 seconds while a run is open is 20 a minute.
      await deps.enforceUserRateLimit({
        userId: user.userId,
        key: 'albatross-thread-runs',
        limit: 90,
        windowMs: 60_000,
      });
      const { workId } = await context.params;
      const runs = await deps.convexQuery<ThreadRunsResponse['runs']>(
        api.albatrossStepRuns.runsForWorkHistory,
        {
          userId: user.userId,
          workId: String(workId || '').slice(0, 80),
        },
      );
      const body: ThreadRunsResponse = { ok: true, runs: runs || [] };
      return Response.json(body, { headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      if (error instanceof RateLimitError) return rateLimitResponse(error);
      const status = error instanceof AuthRequiredError ? 401 : 500;
      return Response.json(
        {
          ok: false,
          error: errorAnswerMessage(status, error, 'The runs did not load.', '[albatross/runs] failed'),
        },
        { status },
      );
    }
  };
}

export const GET = createThreadRunsGet();
