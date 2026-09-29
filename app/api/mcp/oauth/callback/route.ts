import { type NextRequest, NextResponse } from 'next/server';
import { describeModelError } from '@/lib/ai/log-error';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation } from '@/lib/hosted/convex';
import { hostedPublicUrl } from '@/lib/hosted/env';
import { saveOAuthConnection } from '@/lib/mcp/connections';
import { finishMcpOAuth, type PersistedMcpOAuthState } from '@/lib/mcp/oauth';
import { completeMcpOAuthConnection, type McpOAuthCompletionPayload } from '@/lib/mcp/oauth-connection';
import { getServerDef } from '@/lib/mcp/servers';
import { syncConnection } from '@/lib/mcp/sync';
import { decryptSecret } from '@/lib/security/crypto';
import { saveOAuthCompletion } from '@/lib/security/oauth-completions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const defaultDeps = {
  convexMutation,
  getServerDef,
  decryptSecret,
  finishMcpOAuth,
  saveOAuthConnection,
  syncConnection,
  requireCurrentUser,
  saveOAuthCompletion: (input: { userId: string; kind: 'mcp'; payload: McpOAuthCompletionPayload }) =>
    saveOAuthCompletion(input),
};

function settingsRedirect(
  key: 'mcp_connected' | 'mcp_error' | 'mcp_completion',
  value: string,
  nativeCallback = false,
) {
  if (nativeCallback) {
    const target = new URL('lab86://oauth/connection');
    target.searchParams.set(key, value.slice(0, 300));
    return NextResponse.redirect(target);
  }
  const target = new URL('/settings', hostedPublicUrl());
  target.searchParams.set(key, value.slice(0, 300));
  return NextResponse.redirect(target);
}

// The OAuth state alone does not prove who approved the provider: a user can
// start a connection and send the provider link to someone else. The web flow
// therefore requires the Clerk session of the user who started it. The native
// flow has no session in the system browser, so it keeps the provider result
// for the app to redeem through the authenticated /api/mcp/oauth/finalize.
export function createMcpOAuthCallback(deps: typeof defaultDeps = defaultDeps) {
  return async function mcpOAuthCallback(req: NextRequest) {
    const state = req.nextUrl.searchParams.get('state') || '';
    const code = req.nextUrl.searchParams.get('code') || '';
    const providerError =
      req.nextUrl.searchParams.get('error_description') || req.nextUrl.searchParams.get('error');
    if (!state) return settingsRedirect('mcp_error', 'Missing OAuth state.');

    let nativeCallback = false;
    try {
      const stored = await deps.convexMutation<any>(api.mcp.consumeOAuthStateFromCallback, {
        state,
      });
      if (!stored) return settingsRedirect('mcp_error', 'OAuth state is invalid or expired.');
      nativeCallback = stored.nativeCallback === true;
      if (providerError) {
        console.warn('[mcp/oauth/callback] provider denied authorization', providerError);
        return settingsRedirect(
          'mcp_error',
          'Authorization was not completed. Please try again.',
          nativeCallback,
        );
      }
      if (!code) {
        return settingsRedirect(
          'mcp_error',
          'The provider did not return an authorization code.',
          nativeCallback,
        );
      }

      const definition = deps.getServerDef(stored.server);
      if (!definition || definition.connectMode !== 'oauth') throw new Error('Unsupported OAuth server.');
      const persisted = JSON.parse(deps.decryptSecret(stored.payloadEncrypted)) as PersistedMcpOAuthState;
      if (persisted.state !== state) throw new Error('OAuth state did not match.');
      if (nativeCallback) {
        const completionToken = await deps.saveOAuthCompletion({
          userId: stored.userId,
          kind: 'mcp',
          payload: { server: stored.server, code, persisted },
        });
        return settingsRedirect('mcp_completion', completionToken, true);
      }
      const sessionUser = await deps.requireCurrentUser().catch(() => null);
      if (!sessionUser || sessionUser.userId !== stored.userId) {
        return settingsRedirect('mcp_error', 'Sign in again and retry the connection.');
      }
      const result = await completeMcpOAuthConnection(
        { userId: stored.userId, server: stored.server, code, persisted },
        deps,
      );
      if (!result.ok) {
        console.warn('[mcp/oauth/callback] initial sync failed', definition.id, result.error);
        return settingsRedirect(
          'mcp_error',
          'Connected, but the first sync failed. Please reconnect and try again.',
        );
      }
      return settingsRedirect('mcp_connected', result.label);
    } catch (error) {
      console.error('[mcp/oauth/callback] OAuth connection failed', describeModelError(error));
      return settingsRedirect(
        'mcp_error',
        'Could not complete authorization. Please sign in and try again.',
        nativeCallback,
      );
    }
  };
}

export const GET = createMcpOAuthCallback();
