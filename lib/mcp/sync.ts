import { api, convexMutation } from '@/lib/hosted/convex';
import { callMcpTool, connectMcp, type McpClientHandle } from './client';
import { getConnectionToken, listUserConnections } from './connections';
import { getServerDef, type NormalizedMcpItem, normalizeItems } from './servers';

const mcpApi = (api as any).mcp;

function classifyError(err: unknown): string {
  const code = Number((err as { statusCode?: number; code?: number })?.statusCode ?? (err as any)?.code);
  if (code === 401 || code === 403) return 'auth rejected — reconnect with a valid token';
  return String((err as { message?: string })?.message || 'sync failed').slice(0, 200);
}

export async function syncConnection(
  userId: string,
  connectionId: string,
): Promise<{ ok: boolean; count: number; error?: string }> {
  const resolved = await getConnectionToken(userId, connectionId);
  if (!resolved) {
    await convexMutation(mcpApi.setSyncState, {
      userId,
      connectionId,
      server: 'unknown',
      status: 'error',
      error: 'missing or unreadable credentials',
    });
    return { ok: false, count: 0, error: 'missing credentials' };
  }
  const { row, token } = resolved;
  const def = getServerDef(row.server);
  if (!def) return { ok: false, count: 0, error: 'unknown server' };

  await convexMutation(mcpApi.setSyncState, {
    userId,
    connectionId,
    server: row.server,
    status: 'syncing',
  });

  let handle: McpClientHandle;
  try {
    handle = await connectMcp(row.serverUrl, token);
  } catch (err) {
    const error = classifyError(err);
    await convexMutation(mcpApi.setSyncState, {
      userId,
      connectionId,
      server: row.server,
      status: 'error',
      error,
    });
    return { ok: false, count: 0, error };
  }

  const items: NormalizedMcpItem[] = [];
  const seen = new Set<string>();
  try {
    for (const query of def.syncQueries) {
      // Skip tools the server doesn't actually expose (graceful vendor drift).
      if (handle.toolNames.size && !handle.toolNames.has(query.tool)) continue;
      try {
        const result = await callMcpTool(handle, query.tool, query.args);
        for (const item of normalizeItems(query, result)) {
          if (seen.has(item.externalId)) continue;
          seen.add(item.externalId);
          items.push(item);
        }
      } catch {
        // One failing query shouldn't sink the whole connection's sync.
      }
    }
  } finally {
    await handle.close();
  }

  if (items.length) {
    await convexMutation(mcpApi.upsertItems, {
      userId,
      connectionId,
      server: row.server,
      items,
    });
  }
  await convexMutation(mcpApi.setSyncState, {
    userId,
    connectionId,
    server: row.server,
    status: 'ready',
    lastSyncedAt: Date.now(),
    itemCount: items.length,
  });
  return { ok: true, count: items.length };
}

export async function syncAllMcpConnections(userId: string): Promise<{ connections: number; items: number }> {
  const connections = (await listUserConnections(userId)).filter((c) => c.status === 'connected');
  let items = 0;
  for (const connection of connections) {
    const result = await syncConnection(userId, connection.connectionId).catch(() => ({
      ok: false,
      count: 0,
    }));
    items += result.count || 0;
  }
  return { connections: connections.length, items };
}
