import { z } from 'zod';
import { runWithAiRequestContext } from '@/lib/ai/context';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import {
  enforceLocalRateLimit,
  enforceUserRateLimit,
  RateLimitError,
  rateLimitResponse,
} from '@/lib/rate-limit';
import { errorAnswerMessage } from '@/lib/security/error-answer';
import { readBriefEditionView, readBriefHead, readBriefView } from '@/lib/store/daily-reports';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const input = z.object({
  id: z.string().min(1).max(240).optional(),
  known: z.string().max(64).nullish(),
});

const defaultDependencies = {
  requireCurrentUser,
  enforceUserRateLimit,
  enforceLocalRateLimit,
  readBriefHead,
  readBriefView,
  readBriefEditionView,
};

function failure(error: unknown) {
  if (error instanceof RateLimitError) return rateLimitResponse(error);
  const status = error instanceof AuthRequiredError ? 401 : 500;
  const message = errorAnswerMessage(status, error, 'Could not load the brief.', '[brief/view] failed');
  return Response.json({ error: message }, { status });
}

/** The poll of the Today page. It costs one small Convex read and no mutation. */
export function createBriefHeadGet(deps = defaultDependencies) {
  return async function GET() {
    try {
      const user = await deps.requireCurrentUser();
      deps.enforceLocalRateLimit({ userId: user.userId, key: 'brief-head', limit: 120, windowMs: 60_000 });
      return Response.json(
        await runWithAiRequestContext({ userId: user.userId, agent: 'user' }, deps.readBriefHead),
      );
    } catch (error) {
      return failure(error);
    }
  };
}

/** One edition in the slim web form. The latest read carries its live facts. */
export function createBriefViewPost(deps = defaultDependencies) {
  return async function POST(req: Request) {
    try {
      const user = await deps.requireCurrentUser();
      await deps.enforceUserRateLimit({
        userId: user.userId,
        key: 'brief-view',
        limit: 60,
        windowMs: 60_000,
      });
      const parsed = input.safeParse(await req.json().catch(() => ({})));
      if (!parsed.success) return Response.json({ error: 'Invalid brief request.' }, { status: 400 });
      const { id, known } = parsed.data;
      return Response.json(
        await runWithAiRequestContext({ userId: user.userId, agent: 'user' }, () =>
          id ? deps.readBriefEditionView(id, known) : deps.readBriefView(known),
        ),
      );
    } catch (error) {
      return failure(error);
    }
  };
}

export const GET = createBriefHeadGet();
export const POST = createBriefViewPost();
