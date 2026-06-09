import { NextResponse } from 'next/server';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexQuery } from '@/lib/hosted/convex';
import { isConvexConfigured, isNylasConfigured } from '@/lib/hosted/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await requireCurrentUser().catch((err) => {
    if (err instanceof AuthRequiredError) return null;
    throw err;
  });
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Sign in required.' }, { status: 401 });
  }
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
