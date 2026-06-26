import { randomBytes } from 'node:crypto';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { decryptSecret, encryptSecret, maskFingerprint, secretFingerprint } from '@/lib/security/crypto';
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
  const result = await convexQuery<{ connection: any; credentials: any } | null>(
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
  return { row: result.connection as McpConnectionRow, token };
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
