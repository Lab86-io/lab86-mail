import { type NextRequest, NextResponse } from 'next/server';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation } from '@/lib/hosted/convex';
import { hostedPublicUrl } from '@/lib/hosted/env';
import { saveOAuthConnection } from '@/lib/mcp/connections';
import { finishMcpOAuth, type PersistedMcpOAuthState } from '@/lib/mcp/oauth';
import { getServerDef, type McpServerId } from '@/lib/mcp/servers';
import { syncConnection } from '@/lib/mcp/sync';
import { decryptSecret } from '@/lib/security/crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const defaultDeps = {
  requireCurrentUser,
  convexMutation,
  getServerDef,
  decryptSecret,
  finishMcpOAuth,
  saveOAuthConnection,
  syncConnection,
};

function settingsRedirect(key: 'mcp_connected' | 'mcp_error', value: string) {
  const target = new URL('/settings', hostedPublicUrl());
  target.searchParams.set(key, value.slice(0, 300));
  return NextResponse.redirect(target);
}

export function createMcpOAuthCallback(deps: typeof defaultDeps = defaultDeps) {
  return async function mcpOAuthCallback(req: NextRequest) {
    const state = req.nextUrl.searchParams.get('state') || '';
    const code = req.nextUrl.searchParams.get('code') || '';
    const providerError =
      req.nextUrl.searchParams.get('error_description') || req.nextUrl.searchParams.get('error');
    if (!state) return settingsRedirect('mcp_error', 'Missing OAuth state.');

    try {
      const user = await deps.requireCurrentUser();
      const stored = await deps.convexMutation<any>((api as any).mcp.consumeOAuthState, {
        userId: user.userId,
        state,
      });
      if (!stored) return settingsRedirect('mcp_error', 'OAuth state is invalid or expired.');
      if (providerError) {
        console.warn('[mcp/oauth/callback] provider denied authorization', providerError);
        return settingsRedirect('mcp_error', 'Authorization was not completed. Please try again.');
      }
      if (!code) return settingsRedirect('mcp_error', 'The provider did not return an authorization code.');

      const definition = deps.getServerDef(stored.server);
      if (!definition || definition.connectMode !== 'oauth') throw new Error('Unsupported OAuth server.');
      const persisted = JSON.parse(deps.decryptSecret(stored.payloadEncrypted)) as PersistedMcpOAuthState;
      if (persisted.state !== state) throw new Error('OAuth state did not match.');
      const completed = await deps.finishMcpOAuth({
        serverUrl: definition.defaultUrl,
        code,
        persisted,
      });
      const { connectionId } = await deps.saveOAuthConnection({
        userId: user.userId,
        server: stored.server as McpServerId,
        persisted: completed,
        displayName: definition.label,
      });
      const validation = await deps.syncConnection(user.userId, connectionId);
      if (!validation.ok) {
        console.warn('[mcp/oauth/callback] initial sync failed', definition.id, validation.error);
        return settingsRedirect(
          'mcp_error',
          'Connected, but the first sync failed. Please reconnect and try again.',
        );
      }
      return settingsRedirect('mcp_connected', definition.label);
    } catch (error) {
      console.error('[mcp/oauth/callback] OAuth connection failed', error);
      return settingsRedirect('mcp_error', 'Could not complete authorization. Please sign in and try again.');
    }
  };
}

export const GET = createMcpOAuthCallback();
