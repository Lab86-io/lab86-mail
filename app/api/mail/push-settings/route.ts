import { z } from 'zod';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import type { MailPushSettings } from '@/lib/notifications/mail-push';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Mail push settings for web and native (FEATURES item 12): priority-only
// mode, quiet hours, and VIP senders.
//
// GET  → { ok, settings: { mode, quietHours: { enabled, start, end }, vipSenders, timezone } }
// PUT  { mode?, quietHours?: { enabled?, start?, end? }, vipSenders?, addVipSenders?,
//        removeVipSenders?, timezone? } → { ok, settings }

const hour = z.number().int().min(0).max(23);
const senders = z.array(z.string().trim().min(1).max(254)).max(200);

const MailPushSettingsUpdateSchema = z
  .object({
    mode: z.enum(['all', 'priority']).optional(),
    quietHours: z
      .object({ enabled: z.boolean().optional(), start: hour.optional(), end: hour.optional() })
      .strict()
      .optional(),
    vipSenders: senders.optional(),
    addVipSenders: senders.optional(),
    removeVipSenders: senders.optional(),
    // Only used when the user has no notification preferences yet.
    timezone: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

interface Dependencies {
  requireCurrentUser: typeof requireCurrentUser;
  enforceUserRateLimit: typeof enforceUserRateLimit;
  query: typeof convexQuery;
  mutate: typeof convexMutation;
}

const defaults: Dependencies = {
  requireCurrentUser,
  enforceUserRateLimit,
  query: convexQuery,
  mutate: convexMutation,
};

function failure(error: unknown) {
  if (error instanceof AuthRequiredError)
    return Response.json({ ok: false, error: error.message }, { status: 401 });
  if (error instanceof RateLimitError) return rateLimitResponse(error);
  if (error instanceof SyntaxError || error instanceof z.ZodError)
    return Response.json({ ok: false, error: 'Invalid mail alert settings.' }, { status: 400 });
  const message = error instanceof Error ? error.message : '';
  if (/Quiet hours must|Enter an email address or a domain/.test(message))
    return Response.json({ ok: false, error: message }, { status: 400 });
  return Response.json(
    { ok: false, error: 'Mail alert settings are unavailable. Try again.' },
    { status: 500 },
  );
}

export function createMailPushSettingsRoute(overrides: Partial<Dependencies> = {}) {
  const deps = { ...defaults, ...overrides };
  const settingsApi = (api as any).albatrossNotifications;
  return {
    async GET() {
      try {
        const user = await deps.requireCurrentUser();
        const settings = await deps.query<MailPushSettings>(settingsApi.mailPushSettings, {
          userId: user.userId,
        });
        return Response.json({ ok: true, settings });
      } catch (error) {
        return failure(error);
      }
    },
    async PUT(request: Request) {
      try {
        const user = await deps.requireCurrentUser();
        await deps.enforceUserRateLimit({
          userId: user.userId,
          key: 'mail-push-settings',
          limit: 30,
          windowMs: 60_000,
        });
        const body = MailPushSettingsUpdateSchema.parse(await request.json());
        const settings = await deps.mutate<MailPushSettings>(settingsApi.saveMailPushSettings, {
          userId: user.userId,
          mode: body.mode,
          quietHoursEnabled: body.quietHours?.enabled,
          quietHoursStart: body.quietHours?.start,
          quietHoursEnd: body.quietHours?.end,
          vipSenders: body.vipSenders,
          addVipSenders: body.addVipSenders,
          removeVipSenders: body.removeVipSenders,
          timezone: body.timezone || request.headers.get('x-user-timezone') || undefined,
        });
        return Response.json({ ok: true, settings });
      } catch (error) {
        return failure(error);
      }
    },
  };
}

const route = createMailPushSettingsRoute();
export const GET = route.GET;
export const PUT = route.PUT;
