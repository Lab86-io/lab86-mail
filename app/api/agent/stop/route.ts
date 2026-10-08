import { stopThreadReply } from '@/lib/albatross/thread-replies';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '@/lib/rate-limit';
import { errorAnswerMessage } from '@/lib/security/error-answer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The chat Stop button for a Work thread (docs/albatross-threads.md, T11): the
// reply runs on the server after the browser leaves, so Stop must reach the
// server, not only close the stream on one device.

const defaults = { requireCurrentUser, enforceUserRateLimit, stopThreadReply };

export function createAgentStopPost(deps = defaults) {
  return async function POST(req: Request) {
    try {
      const user = await deps.requireCurrentUser();
      await deps.enforceUserRateLimit({
        userId: user.userId,
        key: 'agent-stop',
        limit: 60,
        windowMs: 60_000,
      });
      const body = (await req.json().catch(() => ({}))) as { sessionId?: unknown };
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
      if (!/^work-[A-Za-z0-9_-]{3,59}$/.test(sessionId))
        return Response.json({ ok: false, error: 'A thread sessionId is required.' }, { status: 400 });
      const stopped = await deps.stopThreadReply({
        userId: user.userId,
        sessionId,
        workId: sessionId.slice('work-'.length),
      });
      return Response.json({ ok: true, stopped });
    } catch (error) {
      if (error instanceof RateLimitError) return rateLimitResponse(error);
      const status = error instanceof AuthRequiredError ? 401 : 500;
      return Response.json(
        {
          ok: false,
          error: errorAnswerMessage(status, error, 'The reply did not stop.', '[agent/stop] failed'),
        },
        { status },
      );
    }
  };
}

export const POST = createAgentStopPost();
