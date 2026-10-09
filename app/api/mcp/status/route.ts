import { NextResponse } from 'next/server';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { listUserConnections } from '@/lib/mcp/connections';
import { listServerDefs } from '@/lib/mcp/servers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await requireCurrentUser();
  const connections = await listUserConnections(user.userId);
  // Never leak secrets — listUserConnections returns display rows only.
  return NextResponse.json({
    ok: true,
    connections,
    servers: listServerDefs().map((s) => ({
      id: s.id,
      label: s.label,
      tokenLabel: s.tokenLabel,
      tokenHelp: s.tokenHelp,
      connectMode: s.connectMode,
    })),
  });
}
