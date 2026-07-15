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

function settingsRedirect(key: 'mcp_connected' | 'mcp_error', value: string) {
  const target = new URL('/settings', hostedPublicUrl());
  target.searchParams.set(key, value.slice(0, 300));
  return NextResponse.redirect(target);
}

export async function GET(req: NextRequest) {
  const user = await requireCurrentUser();
  const state = req.nextUrl.searchParams.get('state') || '';
  const code = req.nextUrl.searchParams.get('code') || '';
  const providerError =
    req.nextUrl.searchParams.get('error_description') || req.nextUrl.searchParams.get('error');
  if (!state) return settingsRedirect('mcp_error', 'Missing OAuth state.');

  const stored = await convexMutation<any>((api as any).mcp.consumeOAuthState, {
    userId: user.userId,
    state,
  });
  if (!stored) return settingsRedirect('mcp_error', 'OAuth state is invalid or expired.');
  if (providerError) return settingsRedirect('mcp_error', providerError);
  if (!code) return settingsRedirect('mcp_error', 'The provider did not return an authorization code.');

  try {
    const definition = getServerDef(stored.server);
    if (!definition || definition.connectMode !== 'oauth') throw new Error('Unsupported OAuth server.');
    const persisted = JSON.parse(decryptSecret(stored.payloadEncrypted)) as PersistedMcpOAuthState;
    if (persisted.state !== state) throw new Error('OAuth state did not match.');
    const completed = await finishMcpOAuth({
      serverUrl: definition.defaultUrl,
      code,
      persisted,
    });
    const { connectionId } = await saveOAuthConnection({
      userId: user.userId,
      server: stored.server as McpServerId,
      persisted: completed,
      displayName: definition.label,
    });
    const validation = await syncConnection(user.userId, connectionId);
    if (!validation.ok) {
      return settingsRedirect(
        'mcp_error',
        `Connected ${definition.label}, but its first sync failed: ${validation.error || 'unknown error'}`,
      );
    }
    return settingsRedirect('mcp_connected', definition.label);
  } catch (error) {
    return settingsRedirect('mcp_error', (error as Error)?.message || 'OAuth connection failed.');
  }
}
