import { randomBytes } from 'node:crypto';
import { type NextRequest, NextResponse } from 'next/server';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation } from '@/lib/hosted/convex';
import { beginMcpOAuth } from '@/lib/mcp/oauth';
import { getServerDef, type McpServerId } from '@/lib/mcp/servers';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';
import { encryptSecret } from '@/lib/security/crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await requireCurrentUser();
  try {
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'mcp_oauth_connect',
      limit: 10,
      windowMs: 10 * 60_000,
    });
  } catch (error) {
    if (error instanceof RateLimitError) return rateLimitJson(error);
    throw error;
  }

  const server = req.nextUrl.searchParams.get('server') || '';
  const definition = getServerDef(server);
  if (!definition || definition.connectMode !== 'oauth') {
    return NextResponse.json({ ok: false, error: `Unsupported OAuth server: ${server}` }, { status: 400 });
  }

  try {
    const state = randomBytes(32).toString('base64url');
    const started = await beginMcpOAuth({ serverUrl: definition.defaultUrl, state });
    await convexMutation((api as any).mcp.saveOAuthState, {
      userId: user.userId,
      state,
      server: server as McpServerId,
      payloadEncrypted: encryptSecret(JSON.stringify(started.persisted)),
      nativeCallback: req.nextUrl.searchParams.get('native') === '1',
      expiresAt: Date.now() + 10 * 60_000,
    });
    if (req.nextUrl.searchParams.get('format') === 'json') {
      return NextResponse.json({ ok: true, authorizationUrl: started.authorizationUrl });
    }
    return NextResponse.redirect(started.authorizationUrl);
  } catch (error) {
    const target = new URL('/settings', req.nextUrl.origin);
    target.searchParams.set('mcp_error', (error as Error)?.message || 'Could not start OAuth.');
    return NextResponse.redirect(target);
  }
}
