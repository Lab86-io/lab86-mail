import { NextResponse } from 'next/server';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { clerkBillingPortalUrl } from '@/lib/hosted/billing';
import { isSubscriptionServiceDisabled } from '@/lib/hosted/controls';

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
  await requireCurrentUser({ allowLegacy: false });
  const url = clerkBillingPortalUrl() || '/pricing';
  return NextResponse.json({ ok: true, url });
}
