import { NextRequest, NextResponse } from 'next/server';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation } from '@/lib/hosted/convex';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest) {
  const user = await requireCurrentUser({ allowLegacy: false });
  const body = await req.json().catch(() => ({}));
  const accountId = String(body.accountId || '');
  if (!accountId) {
    return NextResponse.json({ ok: false, error: 'accountId is required' }, { status: 400 });
  }
  await convexMutation(api.accounts.updateConnectedAccountAlias, {
    userId: user.userId,
    accountId,
    displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
  });
  return NextResponse.json({ ok: true });
}
