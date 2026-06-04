import { NextResponse } from 'next/server';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexQuery } from '@/lib/hosted/convex';
import { isConvexConfigured, isNylasConfigured } from '@/lib/hosted/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await requireCurrentUser();
  const accounts = isConvexConfigured()
    ? await convexQuery<any[]>(api.accounts.listConnectedAccounts, { userId: user.userId }).catch(() => [])
    : [];
  return NextResponse.json({
    ok: true,
    configured: {
      convex: isConvexConfigured(),
      nylas: isNylasConfigured(),
    },
    accounts,
  });
}
