import { NextResponse } from 'next/server';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { clerkBillingCheckoutUrl } from '@/lib/hosted/billing';
import { api, convexMutation } from '@/lib/hosted/convex';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const user = await requireCurrentUser({ allowLegacy: false });
  await convexMutation(api.users.upsertFromClerk, {
    userId: user.userId,
    email: user.email,
    name: user.name,
  }).catch(() => undefined);
  const url = clerkBillingCheckoutUrl() || '/pricing';
  return NextResponse.json({ ok: true, url });
}
