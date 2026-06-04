import { NextRequest, NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { api, convexMutation } from '@/lib/hosted/convex';
import { aiCreditDefaults } from '@/lib/hosted/env';
import { requireStripe } from '@/lib/hosted/stripe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const signature = req.headers.get('stripe-signature') || '';
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret)
    return NextResponse.json({ ok: false, error: 'STRIPE_WEBHOOK_SECRET is required.' }, { status: 503 });
  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = requireStripe().webhooks.constructEvent(body, signature, secret);
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message || 'invalid webhook' }, { status: 400 });
  }

  if (
    event.type === 'checkout.session.completed' ||
    event.type === 'customer.subscription.created' ||
    event.type === 'customer.subscription.updated' ||
    event.type === 'customer.subscription.deleted'
  ) {
    await mirrorEntitlement(event.data.object as any);
  }
  return NextResponse.json({ ok: true });
}

async function mirrorEntitlement(object: any) {
  const subscription =
    object.object === 'subscription'
      ? object
      : object.subscription
        ? await requireStripe().subscriptions.retrieve(object.subscription)
        : null;
  const userId =
    object.metadata?.clerkUserId || subscription?.metadata?.clerkUserId || object.client_reference_id;
  if (!userId) return;
  const customerId =
    typeof object.customer === 'string'
      ? object.customer
      : typeof subscription?.customer === 'string'
        ? subscription.customer
        : undefined;
  const status = normalizeStatus(subscription?.status || object.status);
  await convexMutation(api.ai.upsertEntitlement, {
    userId,
    plan: status === 'active' || status === 'trialing' ? 'pro' : 'free',
    status,
    source: 'stripe',
    monthlyCredits:
      Number(subscription?.metadata?.monthlyCredits || object.metadata?.monthlyCredits) ||
      aiCreditDefaults().proMonthlyCredits,
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscription?.id,
    currentPeriodEnd: subscription?.current_period_end ? subscription.current_period_end * 1000 : undefined,
  });
}

function normalizeStatus(status: string) {
  if (status === 'active' || status === 'trialing' || status === 'past_due' || status === 'canceled') {
    return status;
  }
  return 'inactive';
}
