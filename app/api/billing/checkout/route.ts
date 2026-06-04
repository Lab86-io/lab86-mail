import { NextResponse } from 'next/server';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation } from '@/lib/hosted/convex';
import { aiCreditDefaults, hostedPublicUrl } from '@/lib/hosted/env';
import { requireStripe } from '@/lib/hosted/stripe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const user = await requireCurrentUser({ allowLegacy: false });
  const price = process.env.STRIPE_PRO_PRICE_ID;
  if (!price)
    return NextResponse.json({ ok: false, error: 'STRIPE_PRO_PRICE_ID is required.' }, { status: 503 });
  await convexMutation(api.users.upsertFromClerk, {
    userId: user.userId,
    email: user.email,
    name: user.name,
  });
  const session = await requireStripe().checkout.sessions.create({
    mode: 'subscription',
    customer_email: user.email || undefined,
    line_items: [{ price, quantity: 1 }],
    success_url: `${hostedPublicUrl()}/?billing=success`,
    cancel_url: `${hostedPublicUrl()}/?billing=cancelled`,
    client_reference_id: user.userId,
    metadata: {
      clerkUserId: user.userId,
      monthlyCredits: String(aiCreditDefaults().proMonthlyCredits),
    },
    subscription_data: {
      metadata: {
        clerkUserId: user.userId,
        monthlyCredits: String(aiCreditDefaults().proMonthlyCredits),
      },
    },
  });
  return NextResponse.json({ ok: true, url: session.url });
}
