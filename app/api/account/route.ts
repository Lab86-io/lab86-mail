import { clerkClient } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { deleteNylasAccount } from '@/lib/nylas/provider';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE() {
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'account_delete',
      limit: 3,
      windowMs: 60 * 60_000,
    });
    const accounts = await convexQuery<any[]>(api.accounts.listConnectedAccounts, { userId: user.userId });
    const disconnected: Array<{ accountId: string; ok: boolean; error?: string }> = [];
    for (const row of accounts) {
      try {
        await deleteNylasAccount(user.userId, row.accountId, row.grantId);
        disconnected.push({ accountId: row.accountId, ok: true });
      } catch (err: any) {
        disconnected.push({
          accountId: row.accountId,
          ok: false,
          error: err?.message || 'disconnect failed',
        });
      }
    }

    const cascade = await convexMutation<any>((api as any).accounts.deleteUserCascade, {
      userId: user.userId,
    });
    const client = await clerkClient();
    await client.users.deleteUser(user.userId);

    return NextResponse.json({ ok: true, disconnected, cascade });
  } catch (err: any) {
    if (err instanceof RateLimitError) return rateLimitJson(err);
    const status = err instanceof AuthRequiredError ? 401 : 500;
    return NextResponse.json({ ok: false, error: err?.message || 'account deletion failed' }, { status });
  }
}
