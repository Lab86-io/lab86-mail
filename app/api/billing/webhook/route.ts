import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  return NextResponse.json(
    {
      ok: false,
      error: 'Stripe Billing webhooks are disabled. Clerk Billing events are handled at /api/clerk/webhook.',
    },
    { status: 410 },
  );
}
