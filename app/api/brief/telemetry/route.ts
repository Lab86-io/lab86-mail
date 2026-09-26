import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { getAiBillingEntitlement } from '@/lib/hosted/billing';
import { api, convexQuery } from '@/lib/hosted/convex';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Internal, admin only (FEATURES item 5): a summary of edition time, model
// cost, tokens, fallbacks, and spent budgets over the last `days` (1-30,
// default 7). Only an operator on the Clerk admin plan may read it.
const defaults = {
  requireCurrentUser,
  isOperator: () =>
    getAiBillingEntitlement()
      .then((entitlement) => entitlement.plan === 'admin')
      .catch(() => false),
  summary: (since: number) => convexQuery<any>((api as any).dailyReports.editionTelemetrySummary, { since }),
  now: () => Date.now(),
};

export function createBriefTelemetryGet(deps = defaults) {
  return async function GET(request: Request) {
    try {
      await deps.requireCurrentUser();
    } catch (error) {
      if (error instanceof AuthRequiredError) return Response.json({ error: error.message }, { status: 401 });
      return Response.json({ error: 'Could not check the account.' }, { status: 500 });
    }
    if (!(await deps.isOperator())) return Response.json({ error: 'Operators only.' }, { status: 403 });
    const raw = Number(new URL(request.url).searchParams.get('days') || 7);
    const days = Number.isFinite(raw) ? Math.min(30, Math.max(1, Math.floor(raw))) : 7;
    try {
      const summary = await deps.summary(deps.now() - days * 86_400_000);
      return Response.json({ ok: true, days, summary });
    } catch {
      return Response.json({ error: 'Could not read the brief telemetry.' }, { status: 500 });
    }
  };
}

export const GET = createBriefTelemetryGet();
