import type { NextRequest } from 'next/server';
import { localDateKey } from '@/lib/albatross/work-v2';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation } from '@/lib/hosted/convex';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const user = await requireCurrentUser();
    const body = await req.json().catch(() => ({}));
    const timezone =
      typeof body.timezone === 'string' ? body.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone;
    const result = await convexMutation<any>((api as any).albatrossNotifications.ensureCheckin, {
      userId: user.userId,
      localDate: localDateKey(timezone),
      timezone,
    });
    return Response.json({ ok: true, ...result });
  } catch (error) {
    const status = error instanceof AuthRequiredError ? 401 : 500;
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : 'check-in failed' },
      { status },
    );
  }
}
