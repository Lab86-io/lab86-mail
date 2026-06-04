import { NextResponse } from 'next/server';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexQuery } from '@/lib/hosted/convex';
import { hostedPublicUrl } from '@/lib/hosted/env';
import { requireStripe } from '@/lib/hosted/stripe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const user = await requireCurrentUser({ allowLegacy: false });
  const state = await convexQuery<any>(api.ai.getRuntimeState, { userId: user.userId });
  const customer = state.entitlement?.stripeCustomerId;
  if (!customer) {
    return NextResponse.json(
      { ok: false, error: 'No Stripe customer found. Start checkout first.' },
      { status: 404 },
    );
  }
  const session = await requireStripe().billingPortal.sessions.create({
    customer,
    return_url: `${hostedPublicUrl()}/?billing=portal`,
  });
  return NextResponse.json({ ok: true, url: session.url });
}
