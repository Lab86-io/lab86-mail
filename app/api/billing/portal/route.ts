import { NextResponse } from 'next/server';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { clerkBillingPortalUrl } from '@/lib/hosted/billing';
import { isSubscriptionServiceDisabled } from '@/lib/hosted/controls';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';

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
  const user = await requireCurrentUser();
  try {
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'billing_portal',
      limit: 10,
      windowMs: 10 * 60_000,
    });
  } catch (err) {
    if (err instanceof RateLimitError) return rateLimitJson(err);
    throw err;
  }
  const url = clerkBillingPortalUrl() || '/pricing';
  return NextResponse.json({ ok: true, url });
}
