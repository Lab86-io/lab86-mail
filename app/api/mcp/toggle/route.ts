import { type NextRequest, NextResponse } from 'next/server';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { setConnectionToggles } from '@/lib/mcp/connections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const user = await requireCurrentUser();
  const body = (await req.json().catch(() => ({}))) as {
    connectionId?: string;
    includeInBrief?: boolean;
    includeInSearch?: boolean;
  };
  const connectionId = String(body.connectionId || '');
  if (!connectionId) {
    return NextResponse.json({ ok: false, error: 'connectionId is required.' }, { status: 400 });
  }
  await setConnectionToggles(user.userId, connectionId, {
    includeInBrief: body.includeInBrief,
    includeInSearch: body.includeInSearch,
  });
  return NextResponse.json({ ok: true });
}
