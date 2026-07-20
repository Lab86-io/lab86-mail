import { randomBytes } from 'node:crypto';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { decryptSecret, encryptSecret, maskFingerprint, secretFingerprint } from '@/lib/security/crypto';
import { oauthExpiresAt, oauthScopes, type PersistedMcpOAuthState, refreshMcpOAuth } from './oauth';
import { getServerDef, type McpServerId } from './servers';

const mcpApi = (api as any).mcp;

const defaultDeps = {
  convexMutation,
  convexQuery,
  decryptSecret,
  encryptSecret,
  maskFingerprint,
  secretFingerprint,
  refreshMcpOAuth,
  now: () => Date.now(),
};

let deps = defaultDeps;

export function __setMcpConnectionDepsForTest(overrides: Partial<typeof defaultDeps> = {}) {
  deps = { ...defaultDeps, ...overrides };
}

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

const oauthRefreshes = new Map<string, Promise<string | null>>();

async function refreshConnectionToken(input: {
  userId: string;
  connectionId: string;
  row: McpConnectionRow;
  credentials: McpCredentialsRow;
  token: string;
}): Promise<string | null> {
  const { userId, connectionId, row, credentials } = input;
  if (!credentials.refreshTokenEncrypted || !credentials.oauthClientInformationEncrypted) return null;
  try {
    const refreshToken = deps.decryptSecret(credentials.refreshTokenEncrypted);
    const clientInformation = JSON.parse(
      deps.decryptSecret(credentials.oauthClientInformationEncrypted),
    ) as PersistedMcpOAuthState['clientInformation'];
    const refreshed = await deps.refreshMcpOAuth({
      serverUrl: row.serverUrl,
      persisted: {
        state: `refresh:${connectionId}`,
        clientInformation,
        tokens: { access_token: input.token, refresh_token: refreshToken, token_type: 'Bearer' },
      },
    });
    const nextTokens = refreshed.tokens!;
    const nextClientInformation = refreshed.clientInformation!;
    const nextToken = nextTokens.access_token;
    const expiresAt = oauthExpiresAt(nextTokens);
    const persisted = await deps.convexMutation(mcpApi.updateOAuthCredentials, {
      userId,
      connectionId,
      accessTokenEncrypted: deps.encryptSecret(nextToken),
      refreshTokenEncrypted: nextTokens.refresh_token
        ? deps.encryptSecret(nextTokens.refresh_token)
        : undefined,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      oauthClientInformationEncrypted: deps.encryptSecret(JSON.stringify(nextClientInformation)),
      scopes: oauthScopes(nextTokens, row.scopes),
    });
    if (!persisted || typeof persisted !== 'object' || (persisted as { ok?: unknown }).ok !== true) {
      return null;
    }
    return nextToken;
  } catch {
    return null;
  }
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

  const fingerprint = deps.secretFingerprint(token);
  const connectionId = newConnectionId(opts.server);
  await deps.convexMutation(mcpApi.upsertConnection, {
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
    accessTokenEncrypted: deps.encryptSecret(token),
    fingerprint,
    masked: deps.maskFingerprint(fingerprint),
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
  const fingerprint = deps.secretFingerprint(tokens.access_token);
  await deps.convexMutation(mcpApi.upsertConnection, {
    userId: opts.userId,
    connectionId,
    server: opts.server,
    serverUrl: def.defaultUrl,
    authKind: 'oauth',
    displayName: opts.displayName || def.label,
    scopes: oauthScopes(tokens, def.scopes),
    accessTokenEncrypted: deps.encryptSecret(tokens.access_token),
    refreshTokenEncrypted: tokens.refresh_token ? deps.encryptSecret(tokens.refresh_token) : undefined,
    expiresAt: oauthExpiresAt(tokens),
    oauthClientInformationEncrypted: deps.encryptSecret(JSON.stringify(clientInformation)),
    fingerprint,
    masked: deps.maskFingerprint(fingerprint),
  });
  return { connectionId };
}

export async function listUserConnections(userId: string): Promise<McpConnectionRow[]> {
  const rows = await deps.convexQuery<McpConnectionRow[]>(mcpApi.listConnections, { userId });
  return rows || [];
}

// Server-only: decrypt the stored token for a connection so the sync layer can
// reach the remote server.
export async function getConnectionToken(
  userId: string,
  connectionId: string,
): Promise<{ row: McpConnectionRow; token: string } | null> {
  const result = await deps.convexQuery<{ connection: any; credentials: McpCredentialsRow } | null>(
    mcpApi.getConnectionWithCredentials,
    { userId, connectionId },
  );
  if (!result?.connection || !result.credentials?.accessTokenEncrypted) return null;
  let token: string;
  try {
    token = deps.decryptSecret(result.credentials.accessTokenEncrypted);
  } catch {
    return null;
  }
  const row = result.connection as McpConnectionRow;
  const credentials = result.credentials;
  if (
    row.authKind === 'oauth' &&
    credentials.expiresAt !== undefined &&
    credentials.expiresAt <= deps.now() + 60_000
  ) {
    let refresh = oauthRefreshes.get(connectionId);
    if (!refresh) {
      refresh = refreshConnectionToken({ userId, connectionId, row, credentials, token });
      oauthRefreshes.set(connectionId, refresh);
      void refresh.finally(() => {
        if (oauthRefreshes.get(connectionId) === refresh) oauthRefreshes.delete(connectionId);
      });
    }
    const refreshedToken = await refresh;
    if (!refreshedToken) return null;
    token = refreshedToken;
  }
  return { row, token };
}

export async function disconnectConnection(userId: string, connectionId: string): Promise<void> {
  await deps.convexMutation(mcpApi.disconnectConnection, { userId, connectionId });
}

export async function setConnectionToggles(
  userId: string,
  connectionId: string,
  toggles: { includeInBrief?: boolean; includeInSearch?: boolean },
): Promise<void> {
  await deps.convexMutation(mcpApi.setConnectionToggles, { userId, connectionId, ...toggles });
}
