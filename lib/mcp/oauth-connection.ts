import { saveOAuthConnection } from '@/lib/mcp/connections';
import { finishMcpOAuth, type PersistedMcpOAuthState } from '@/lib/mcp/oauth';
import { getServerDef, type McpServerId } from '@/lib/mcp/servers';
import { syncConnection } from '@/lib/mcp/sync';

// The provider result that a native tool callback keeps until the signed-in
// app redeems it (see lib/security/oauth-completions.ts).
export interface McpOAuthCompletionPayload {
  server: string;
  code: string;
  persisted: PersistedMcpOAuthState;
}

const defaultDependencies = {
  getServerDef,
  finishMcpOAuth,
  saveOAuthConnection,
  syncConnection,
};

export type McpOAuthConnectionDependencies = typeof defaultDependencies;

export type McpOAuthConnectionResult =
  | { ok: true; label: string; connectionId: string }
  | { ok: false; label: string; connectionId: string; error?: string };

/**
 * Exchanges an authorization code and saves the tool connection for `userId`.
 * The caller must first prove that `userId` is the signed-in user: the web
 * callback compares the Clerk session, and the native finalize route reads
 * the user from the app's bearer token.
 */
export async function completeMcpOAuthConnection(
  input: McpOAuthCompletionPayload & { userId: string },
  dependencies: Partial<McpOAuthConnectionDependencies> = {},
): Promise<McpOAuthConnectionResult> {
  const deps = { ...defaultDependencies, ...dependencies };
  const definition = deps.getServerDef(input.server);
  if (!definition || definition.connectMode !== 'oauth') throw new Error('Unsupported OAuth server.');
  const completed = await deps.finishMcpOAuth({
    serverUrl: definition.defaultUrl,
    code: input.code,
    persisted: input.persisted,
  });
  const { connectionId } = await deps.saveOAuthConnection({
    userId: input.userId,
    server: input.server as McpServerId,
    persisted: completed,
    displayName: definition.label,
  });
  const validation = await deps.syncConnection(input.userId, connectionId);
  if (!validation.ok) {
    return { ok: false, label: definition.label, connectionId, error: validation.error };
  }
  return { ok: true, label: definition.label, connectionId };
}
