import { NextResponse } from 'next/server';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { getAiBillingEntitlement } from '@/lib/hosted/billing';
import { isSubscriptionServiceDisabled } from '@/lib/hosted/controls';
import { billingPlanView } from '@/lib/hosted/plans';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const defaults = {
  requireCurrentUser,
  getAiBillingEntitlement: () => getAiBillingEntitlement(),
  isSubscriptionServiceDisabled,
  now: () => Date.now(),
};

/**
 * The signed-in user's plan for web, iOS, and macOS: the plan name, the trial
 * and its "days left" note, and the prices from lib/hosted/plans.ts. Reading
 * it on a Free account that never had a trial starts the 14-day trial.
 *
 * GET → { ok: true, ...BillingPlanView, subscriptionsDisabled: boolean }
 */
export function createBillingPlanGet(overrides: Partial<typeof defaults> = {}) {
  const deps = { ...defaults, ...overrides };
  return async function GET() {
    try {
      await deps.requireCurrentUser();
      const entitlement = await deps.getAiBillingEntitlement();
      return NextResponse.json({
        ok: true,
        ...billingPlanView(entitlement, deps.now()),
        subscriptionsDisabled: deps.isSubscriptionServiceDisabled(),
      });
    } catch (err) {
      if (err instanceof AuthRequiredError)
        return NextResponse.json({ ok: false, error: err.message }, { status: 401 });
      console.error('[billing/plan] failed', err instanceof Error ? err.name : err);
      return NextResponse.json({ ok: false, error: 'Could not load your plan.' }, { status: 500 });
    }
  };
}

export const GET = createBillingPlanGet();
