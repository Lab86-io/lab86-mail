import { type NextRequest, NextResponse } from 'next/server';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { syncAllMcpConnections, syncConnection } from '@/lib/mcp/sync';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const user = await requireCurrentUser();
  try {
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'mcp_resync',
      limit: 30,
      windowMs: 10 * 60_000,
    });
  } catch (err) {
    if (err instanceof RateLimitError) return rateLimitJson(err);
    throw err;
  }

  const body = (await req.json().catch(() => ({}))) as { connectionId?: string };
  const connectionId = String(body.connectionId || '');
  try {
    const result = connectionId
      ? await syncConnection(user.userId, connectionId)
      : await syncAllMcpConnections(user.userId);
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as { message?: string })?.message || 'Sync failed.' },
      { status: 500 },
    );
  }
}
