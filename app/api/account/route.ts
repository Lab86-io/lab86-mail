import { clerkClient } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';
import { deleteUserData } from '@/lib/security/account-deletion';

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
    const result = await deleteUserData(user.userId);
    if (!result.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: 'One or more mail providers could not be disconnected. Account deletion was aborted.',
          disconnected: result.disconnected,
        },
        { status: 502 },
      );
    }
    const client = await clerkClient();
    await client.users.deleteUser(user.userId);

    return NextResponse.json({ ok: true, disconnected: result.disconnected, cascade: result.cascade });
  } catch (err: any) {
    if (err instanceof RateLimitError) return rateLimitJson(err);
    const status = err instanceof AuthRequiredError ? 401 : 500;
    return NextResponse.json({ ok: false, error: err?.message || 'account deletion failed' }, { status });
  }
}
