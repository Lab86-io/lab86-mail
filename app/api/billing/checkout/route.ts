import { NextResponse } from 'next/server';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { clerkBillingCheckoutUrl } from '@/lib/hosted/billing';
import { isSubscriptionServiceDisabled } from '@/lib/hosted/controls';
import { api, convexMutation } from '@/lib/hosted/convex';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  if (isSubscriptionServiceDisabled()) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Subscriptions are temporarily disabled. Add your OpenRouter API key in settings.',
      },
      { status: 503 },
    );
  }
  const user = await requireCurrentUser({ allowLegacy: false });
  await convexMutation(api.users.upsertFromClerk, {
    userId: user.userId,
    email: user.email,
    name: user.name,
  }).catch((error) => {
    // Checkout still proceeds, but leave a trace for the missing Convex record.
    console.error('[checkout] Failed to upsert user to Convex:', error);
  });
  const url = clerkBillingCheckoutUrl() || '/pricing';
  return NextResponse.json({ ok: true, url });
}
