import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexQuery } from '@/lib/hosted/convex';
import { errorAnswerMessage } from '@/lib/security/error-answer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const defaults = { requireCurrentUser, convexQuery };

/** The Brief's "Ready for you" list: open handoffs and runs at work (docs/albatross-step-runner.md). */
export function createHandoffsGet(deps = defaults) {
  return async function GET() {
    try {
      const user = await deps.requireCurrentUser();
      const items = await deps.convexQuery<unknown[]>(api.albatrossStepRuns.openHandoffs, {
        userId: user.userId,
        limit: 8,
      });
      return Response.json({ ok: true, items: items || [] });
    } catch (error) {
      const status = error instanceof AuthRequiredError ? 401 : 500;
      return Response.json(
        {
          ok: false,
          error: errorAnswerMessage(status, error, 'Handoffs failed.', '[albatross/handoffs] failed'),
        },
        { status },
      );
    }
  };
}

export const GET = createHandoffsGet();
