import { type NextRequest, NextResponse } from 'next/server';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { saveTokenConnection } from '@/lib/mcp/connections';
import { getServerDef, type McpServerId } from '@/lib/mcp/servers';
import { syncConnection } from '@/lib/mcp/sync';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const defaultDeps = {
  requireCurrentUser,
  enforceUserRateLimit,
  getServerDef,
  saveTokenConnection,
  syncConnection,
};

// Headless connect: the user pastes a token/PAT for the chosen server. (OAuth
// connect is a planned follow-up; the schema's authKind already allows it.)
export function createMcpConnectPost(deps: typeof defaultDeps = defaultDeps) {
  return async function mcpConnectPost(req: NextRequest) {
    const user = await deps.requireCurrentUser();
    try {
      await deps.enforceUserRateLimit({
        userId: user.userId,
        key: 'mcp_connect',
        limit: 20,
        windowMs: 10 * 60_000,
      });
    } catch (err) {
      if (err instanceof RateLimitError) return rateLimitJson(err);
      throw err;
    }

    const body = (await req.json().catch(() => ({}))) as {
      server?: string;
      token?: string;
      displayName?: string;
    };
    const server = String(body.server || '');
    const token = String(body.token || '');
    const definition = deps.getServerDef(server);
    if (!definition) {
      return NextResponse.json({ ok: false, error: `Unsupported server: ${server}` }, { status: 400 });
    }
    if (definition.connectMode !== 'token') {
      return NextResponse.json(
        { ok: false, error: `${definition.label} must be connected through browser authorization.` },
        { status: 400 },
      );
    }
    if (!token.trim()) {
      return NextResponse.json({ ok: false, error: 'A token is required.' }, { status: 400 });
    }

    try {
      const { connectionId } = await deps.saveTokenConnection({
        userId: user.userId,
        server: server as McpServerId,
        token,
        displayName: body.displayName,
      });
      const validation = await deps.syncConnection(user.userId, connectionId);
      return NextResponse.json({ ok: true, connectionId, validation });
    } catch (err) {
      return NextResponse.json(
        { ok: false, error: (err as { message?: string })?.message || 'Could not connect.' },
        { status: 500 },
      );
    }
  };
}

export const POST = createMcpConnectPost();
