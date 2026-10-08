import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation } from '@/lib/hosted/convex';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '@/lib/rate-limit';
import { errorAnswerMessage } from '@/lib/security/error-answer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The user has a thread on screen (docs/albatross-threads.md, T2). Web calls
// the Convex mutation directly; native calls this route.

const defaults = { requireCurrentUser, enforceUserRateLimit, convexMutation };

export function createThreadSeenPost(deps = defaults) {
  return async function POST(req: Request) {
    try {
      const user = await deps.requireCurrentUser();
      await deps.enforceUserRateLimit({
        userId: user.userId,
        key: 'albatross-thread-seen',
        limit: 120,
        windowMs: 60_000,
      });
      const body = (await req.json().catch(() => ({}))) as { workId?: unknown; unread?: unknown };
      const workId = typeof body.workId === 'string' ? body.workId.trim() : '';
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(workId))
        return Response.json({ ok: false, error: 'workId is required.' }, { status: 400 });
      try {
        const result = await deps.convexMutation<{ seenAt: number }>(api.albatrossThreads.markSeen, {
          userId: user.userId,
          workId,
          ...(body.unread === true ? { unread: true } : {}),
        });
        return Response.json({ ok: true, seenAt: result.seenAt });
      } catch (error) {
        if (/Work not found|Invalid/i.test(String((error as Error)?.message)))
          return Response.json({ ok: false, error: 'Albatross Work not found.' }, { status: 404 });
        throw error;
      }
    } catch (error) {
      if (error instanceof RateLimitError) return rateLimitResponse(error);
      const status = error instanceof AuthRequiredError ? 401 : 500;
      return Response.json(
        {
          ok: false,
          error: errorAnswerMessage(
            status,
            error,
            'The thread was not marked.',
            '[albatross/threads/seen] failed',
          ),
        },
        { status },
      );
    }
  };
}

export const POST = createThreadSeenPost();
