import { z } from 'zod';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation } from '@/lib/hosted/convex';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Brief item telemetry (brief round 2026-09-22). Clients post after an action
// settles. The row never blocks the action, and a bad body is a 400.
export const briefEventSchema = z.object({
  reportId: z.string().trim().min(1).max(240).optional(),
  surface: z.enum(['daily', 'area']).default('daily'),
  regionId: z.string().trim().min(1).max(120),
  action: z.string().trim().min(1).max(80),
  ref: z.object({
    kind: z.string().trim().min(1).max(40),
    id: z.string().trim().min(1).max(240),
    account: z.string().trim().min(1).max(320).optional(),
  }),
  outcome: z.enum(['done', 'failed', 'undone', 'opened']),
});

export type BriefEventInput = z.infer<typeof briefEventSchema>;

const defaultDependencies = { requireCurrentUser, enforceUserRateLimit, convexMutation };

export function createBriefEventsPost(deps = defaultDependencies) {
  return async function POST(req: Request) {
    try {
      const user = await deps.requireCurrentUser();
      await deps.enforceUserRateLimit({
        userId: user.userId,
        key: 'brief-events',
        limit: 240,
        windowMs: 60_000,
      });
      const parsed = briefEventSchema.safeParse(await req.json().catch(() => null));
      if (!parsed.success) return Response.json({ error: 'Invalid brief event.' }, { status: 400 });
      const event = parsed.data;
      await deps.convexMutation(api.briefEvents.record, {
        userId: user.userId,
        reportId: event.reportId,
        surface: event.surface,
        regionId: event.regionId,
        action: event.action,
        refKind: event.ref.kind,
        refId: event.ref.id,
        refAccount: event.ref.account,
        outcome: event.outcome,
      });
      return Response.json({ ok: true });
    } catch (error) {
      if (error instanceof RateLimitError) return rateLimitResponse(error);
      if (error instanceof AuthRequiredError) return Response.json({ error: error.message }, { status: 401 });
      return Response.json({ error: 'Could not record the brief event.' }, { status: 500 });
    }
  };
}

export const POST = createBriefEventsPost();
