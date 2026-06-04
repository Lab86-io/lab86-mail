import { NextResponse } from 'next/server';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { clerkBillingPortalUrl } from '@/lib/hosted/billing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  await requireCurrentUser({ allowLegacy: false });
  const url = clerkBillingPortalUrl() || '/pricing';
  return NextResponse.json({ ok: true, url });
}
