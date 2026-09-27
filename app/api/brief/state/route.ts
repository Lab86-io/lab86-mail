import { z } from 'zod';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexQuery } from '@/lib/hosted/convex';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '@/lib/rate-limit';

const input = z.object({
  refs: z
    .array(z.object({ kind: z.enum(['work', 'task', 'card']), id: z.string().min(1).max(240) }))
    .max(100),
});

const defaultDependencies = { requireCurrentUser, enforceUserRateLimit, convexQuery };
export function createBriefStatePost(deps = defaultDependencies) {
  return async function POST(req: Request) {
    try {
      const user = await deps.requireCurrentUser();
      await deps.enforceUserRateLimit({
        userId: user.userId,
        key: 'brief-state',
        limit: 120,
        windowMs: 60_000,
      });
      const parsed = input.safeParse(await req.json().catch(() => null));
      if (!parsed.success) return Response.json({ error: 'Invalid brief references.' }, { status: 400 });
      const inactive = await deps.convexQuery<string[]>(api.albatrossWorkV2.inactiveBriefRefs, {
        userId: user.userId,
        refs: parsed.data.refs,
      });
      return Response.json({ inactive });
    } catch (error) {
      if (error instanceof RateLimitError) return rateLimitResponse(error);
      if (error instanceof AuthRequiredError) return Response.json({ error: error.message }, { status: 401 });
      return Response.json({ error: 'Could not refresh brief state.' }, { status: 500 });
    }
  };
}
export const POST = createBriefStatePost();
