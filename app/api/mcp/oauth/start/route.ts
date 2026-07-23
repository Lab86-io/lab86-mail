import { randomBytes } from 'node:crypto';
import { type NextRequest, NextResponse } from 'next/server';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation } from '@/lib/hosted/convex';
import { beginMcpOAuth } from '@/lib/mcp/oauth';
import { getServerDef, type McpServerId } from '@/lib/mcp/servers';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';
import { encryptSecret } from '@/lib/security/crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface McpOAuthStartDependencies {
  requireCurrentUser: typeof requireCurrentUser;
  enforceUserRateLimit: typeof enforceUserRateLimit;
  getServerDef: typeof getServerDef;
  beginMcpOAuth: typeof beginMcpOAuth;
  saveOAuthState(args: Record<string, unknown>): Promise<unknown>;
  encryptSecret: typeof encryptSecret;
  randomState: () => string;
  now: () => number;
  reportUnexpectedError: (error: unknown) => void;
}

const defaultDependencies: McpOAuthStartDependencies = {
  requireCurrentUser,
  enforceUserRateLimit,
  getServerDef,
  beginMcpOAuth,
  saveOAuthState: (args) => convexMutation((api as any).mcp.saveOAuthState, args),
  encryptSecret,
  randomState: () => randomBytes(32).toString('base64url'),
  now: Date.now,
  reportUnexpectedError: (error) => console.error('[mcp/oauth/start] failed to start OAuth', error),
};

export function createMcpOAuthStartGet(deps: McpOAuthStartDependencies = defaultDependencies) {
  return async function mcpOAuthStartGet(req: NextRequest) {
    const jsonResponse = req.nextUrl.searchParams.get('format') === 'json';
    try {
      const user = await deps.requireCurrentUser();
      await deps.enforceUserRateLimit({
        userId: user.userId,
        key: 'mcp_oauth_connect',
        limit: 10,
        windowMs: 10 * 60_000,
      });
      const server = req.nextUrl.searchParams.get('server') || '';
      const definition = deps.getServerDef(server);
      if (!definition || definition.connectMode !== 'oauth') {
        return NextResponse.json(
          { ok: false, error: `Unsupported OAuth server: ${server}` },
          { status: 400 },
        );
      }

      const state = deps.randomState();
      const started = await deps.beginMcpOAuth({ serverUrl: definition.defaultUrl, state });
      await deps.saveOAuthState({
        userId: user.userId,
        state,
        server: server as McpServerId,
        payloadEncrypted: deps.encryptSecret(JSON.stringify(started.persisted)),
        nativeCallback: req.nextUrl.searchParams.get('native') === '1',
        expiresAt: deps.now() + 10 * 60_000,
      });
      if (jsonResponse) {
        return NextResponse.json({ ok: true, authorizationUrl: started.authorizationUrl });
      }
      return NextResponse.redirect(started.authorizationUrl);
    } catch (error) {
      if (error instanceof RateLimitError) return rateLimitJson(error);
      if (error instanceof AuthRequiredError) {
        return NextResponse.json({ ok: false, error: error.message }, { status: 401 });
      }
      deps.reportUnexpectedError(error);
      if (jsonResponse) {
        return NextResponse.json({ ok: false, error: 'Could not start OAuth.' }, { status: 502 });
      }
      const target = new URL('/settings', req.nextUrl.origin);
      target.searchParams.set('mcp_error', 'Could not start OAuth.');
      return NextResponse.redirect(target);
    }
  };
}

export const GET = createMcpOAuthStartGet();
