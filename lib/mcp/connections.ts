import { randomBytes } from 'node:crypto';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { decryptSecret, encryptSecret, maskFingerprint, secretFingerprint } from '@/lib/security/crypto';
import { oauthExpiresAt, oauthScopes, type PersistedMcpOAuthState, refreshMcpOAuth } from './oauth';
import { getServerDef, type McpServerId } from './servers';

const mcpApi = (api as any).mcp;

export interface McpConnectionRow {
  connectionId: string;
  server: McpServerId;
  serverUrl: string;
  authKind: 'token' | 'oauth';
  status: 'connected' | 'disconnected' | 'error';
  displayName?: string;
  scopes: string[];
  includeInBrief: boolean;
  includeInSearch: boolean;
  lastSyncedAt?: number;
  error?: string;
  syncStatus?: 'idle' | 'syncing' | 'ready' | 'error';
  itemCount?: number;
  accountEmail?: string;
  workspaceName?: string;
  syncError?: string;
}

interface McpCredentialsRow {
  accessTokenEncrypted?: string;
  refreshTokenEncrypted?: string;
  expiresAt?: number;
  oauthClientInformationEncrypted?: string;
}

export function newConnectionId(server: string): string {
  return `${server}_${randomBytes(8).toString('hex')}`;
}

// Connect a server with a pre-obtained token/PAT (the headless path). The token
// is encrypted before it ever reaches Convex; only a non-reversible fingerprint
// + masked tail are stored for display.
export async function saveTokenConnection(opts: {
  userId: string;
  server: McpServerId;
  token: string;
  displayName?: string;
}): Promise<{ connectionId: string }> {
  const def = getServerDef(opts.server);
  if (!def) throw new Error(`Unknown MCP server: ${opts.server}`);
  if (def.connectMode !== 'token') throw new Error(`${def.label} requires browser authorization.`);
  const token = opts.token.trim();
  if (!token) throw new Error('A token is required to connect.');

  const fingerprint = secretFingerprint(token);
  const connectionId = newConnectionId(opts.server);
  await convexMutation(mcpApi.upsertConnection, {
    userId: opts.userId,
    connectionId,
    server: opts.server,
    // Pinned to the per-server default — never caller-supplied. The bearer
    // token is sent to this host during sync, so an arbitrary serverUrl would
    // be a token-exfiltration / SSRF surface.
    serverUrl: def.defaultUrl,
    authKind: 'token',
    displayName: opts.displayName || def.label,
    scopes: def.scopes,
    accessTokenEncrypted: encryptSecret(token),
    fingerprint,
    masked: maskFingerprint(fingerprint),
  });
  return { connectionId };
}

export async function saveOAuthConnection(opts: {
  userId: string;
  server: McpServerId;
  persisted: PersistedMcpOAuthState;
  displayName?: string;
}): Promise<{ connectionId: string }> {
  const def = getServerDef(opts.server);
  const tokens = opts.persisted.tokens;
  const clientInformation = opts.persisted.clientInformation;
  if (!def || def.connectMode !== 'oauth') throw new Error(`OAuth is not supported for ${opts.server}.`);
  if (!tokens?.access_token || !clientInformation) throw new Error('OAuth credentials are incomplete.');
  const connectionId = newConnectionId(opts.server);
  const fingerprint = secretFingerprint(tokens.access_token);
  await convexMutation(mcpApi.upsertConnection, {
    userId: opts.userId,
    connectionId,
    server: opts.server,
    serverUrl: def.defaultUrl,
    authKind: 'oauth',
    displayName: opts.displayName || def.label,
    scopes: oauthScopes(tokens, def.scopes),
    accessTokenEncrypted: encryptSecret(tokens.access_token),
    refreshTokenEncrypted: tokens.refresh_token ? encryptSecret(tokens.refresh_token) : undefined,
    expiresAt: oauthExpiresAt(tokens),
    oauthClientInformationEncrypted: encryptSecret(JSON.stringify(clientInformation)),
    fingerprint,
    masked: maskFingerprint(fingerprint),
  });
  return { connectionId };
}

export async function listUserConnections(userId: string): Promise<McpConnectionRow[]> {
  const rows = await convexQuery<McpConnectionRow[]>(mcpApi.listConnections, { userId });
  return rows || [];
}

// Server-only: decrypt the stored token for a connection so the sync layer can
// reach the remote server.
export async function getConnectionToken(
  userId: string,
  connectionId: string,
): Promise<{ row: McpConnectionRow; token: string } | null> {
  const result = await convexQuery<{ connection: any; credentials: McpCredentialsRow } | null>(
    mcpApi.getConnectionWithCredentials,
    { userId, connectionId },
  );
  if (!result?.connection || !result.credentials?.accessTokenEncrypted) return null;
  let token: string;
  try {
    token = decryptSecret(result.credentials.accessTokenEncrypted);
  } catch {
    return null;
  }
  const row = result.connection as McpConnectionRow;
  const credentials = result.credentials;
  if (
    row.authKind === 'oauth' &&
    credentials.expiresAt !== undefined &&
    credentials.expiresAt <= Date.now() + 60_000
  ) {
    if (!credentials.refreshTokenEncrypted || !credentials.oauthClientInformationEncrypted) return null;
    try {
      const refreshToken = decryptSecret(credentials.refreshTokenEncrypted);
      const clientInformation = JSON.parse(
        decryptSecret(credentials.oauthClientInformationEncrypted),
      ) as PersistedMcpOAuthState['clientInformation'];
      const refreshed = await refreshMcpOAuth({
        serverUrl: row.serverUrl,
        persisted: {
          state: `refresh:${connectionId}`,
          clientInformation,
          tokens: { access_token: token, refresh_token: refreshToken, token_type: 'Bearer' },
        },
      });
      const nextTokens = refreshed.tokens!;
      const nextClientInformation = refreshed.clientInformation!;
      token = nextTokens.access_token;
      await convexMutation(mcpApi.updateOAuthCredentials, {
        userId,
        connectionId,
        accessTokenEncrypted: encryptSecret(token),
        refreshTokenEncrypted: nextTokens.refresh_token ? encryptSecret(nextTokens.refresh_token) : undefined,
        expiresAt: oauthExpiresAt(nextTokens),
        oauthClientInformationEncrypted: encryptSecret(JSON.stringify(nextClientInformation)),
        scopes: oauthScopes(nextTokens, row.scopes),
      });
    } catch {
      return null;
    }
  }
  return { row, token };
}

export async function disconnectConnection(userId: string, connectionId: string): Promise<void> {
  await convexMutation(mcpApi.disconnectConnection, { userId, connectionId });
}

export async function setConnectionToggles(
  userId: string,
  connectionId: string,
  toggles: { includeInBrief?: boolean; includeInSearch?: boolean },
): Promise<void> {
  await convexMutation(mcpApi.setConnectionToggles, { userId, connectionId, ...toggles });
}
