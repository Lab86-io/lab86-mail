import type { NextRequest } from 'next/server';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexQuery } from '@/lib/hosted/convex';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest) {
  try {
    const user = await requireCurrentUser();
    const [suggestions, checkin] = await Promise.all([
      convexQuery<any[]>((api as any).suggestions.listPending, {
        userId: user.userId,
        limit: 50,
      }),
      convexQuery<any>((api as any).albatrossNotifications.latestUnansweredCheckin, {
        userId: user.userId,
      }),
    ]);
    return Response.json({ ok: true, suggestions, checkin });
  } catch (error) {
    const status = error instanceof AuthRequiredError ? 401 : 500;
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : 'Activity could not be loaded.' },
      { status },
    );
  }
}
