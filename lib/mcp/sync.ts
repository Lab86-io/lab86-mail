import { api, convexMutation } from '@/lib/hosted/convex';
import { loadBitbucketItems } from './bitbucket';
import { callMcpTool, connectMcp, type McpClientHandle } from './client';
import { getConnectionToken, listUserConnections, type McpConnectionRow } from './connections';
import { getServerDef, type NormalizedMcpItem, normalizeItems } from './servers';

const mcpApi = (api as any).mcp;

export interface SyncConnectionDeps {
  getConnectionToken: typeof getConnectionToken;
  listUserConnections: typeof listUserConnections;
  convexMutation: typeof convexMutation;
  loadBitbucketItems: typeof loadBitbucketItems;
  connectMcp: typeof connectMcp;
  callMcpTool: typeof callMcpTool;
}

const defaultDeps: SyncConnectionDeps = {
  getConnectionToken,
  listUserConnections,
  convexMutation,
  loadBitbucketItems,
  connectMcp,
  callMcpTool,
};

function classifyError(err: unknown): string {
  const code = Number((err as { statusCode?: number; code?: number })?.statusCode ?? (err as any)?.code);
  if (code === 401 || code === 403) return 'auth rejected — reconnect with a valid token';
  return String((err as { message?: string })?.message || 'sync failed').slice(0, 200);
}

export async function syncConnection(
  userId: string,
  connectionId: string,
  deps: SyncConnectionDeps = defaultDeps,
): Promise<{ ok: boolean; count: number; error?: string }> {
  const resolved = await deps.getConnectionToken(userId, connectionId);
  if (!resolved) {
    await deps.convexMutation(mcpApi.setSyncState, {
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

  await deps.convexMutation(mcpApi.setSyncState, {
    userId,
    connectionId,
    server: row.server,
    status: 'syncing',
  });

  if (def.transport === 'bitbucket-rest') {
    try {
      const result = await deps.loadBitbucketItems(row.serverUrl, token);
      if (result.items.length) {
        await deps.convexMutation(mcpApi.upsertItems, {
          userId,
          connectionId,
          server: row.server,
          items: result.items,
        });
      }
      await deps.convexMutation(mcpApi.setSyncState, {
        userId,
        connectionId,
        server: row.server,
        status: 'ready',
        lastSyncedAt: Date.now(),
        itemCount: result.items.length,
      });
      return { ok: true, count: result.items.length };
    } catch (err) {
      const error = classifyError(err);
      await deps.convexMutation(mcpApi.setSyncState, {
        userId,
        connectionId,
        server: row.server,
        status: 'error',
        error,
      });
      return { ok: false, count: 0, error };
    }
  }

  let handle: McpClientHandle;
  try {
    handle = await deps.connectMcp(row.serverUrl, token, def.authMode);
  } catch (err) {
    const error = classifyError(err);
    await deps.convexMutation(mcpApi.setSyncState, {
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
  let supportedQueries = 0;
  let successfulQueries = 0;
  const queryErrors: string[] = [];
  try {
    for (const query of def.syncQueries) {
      // Skip tools the server doesn't actually expose (graceful vendor drift).
      if (handle.toolNames.size && !handle.toolNames.has(query.tool)) continue;
      supportedQueries += 1;
      try {
        const result = await deps.callMcpTool(handle, query.tool, query.args);
        successfulQueries += 1;
        for (const item of normalizeItems(query, result)) {
          if (seen.has(item.externalId)) continue;
          seen.add(item.externalId);
          items.push(item);
        }
      } catch (err) {
        queryErrors.push(classifyError(err));
      }
    }
  } finally {
    await handle.close();
  }

  if (def.syncQueries.length && supportedQueries === 0) {
    const error = `remote server did not expose supported tools: ${def.syncQueries.map((q) => q.tool).join(', ')}`;
    await deps.convexMutation(mcpApi.setSyncState, {
      userId,
      connectionId,
      server: row.server,
      status: 'error',
      error,
    });
    return { ok: false, count: 0, error };
  }
  if (def.syncQueries.length && successfulQueries === 0) {
    const error = queryErrors[0] || 'remote server rejected every supported sync query';
    await deps.convexMutation(mcpApi.setSyncState, {
      userId,
      connectionId,
      server: row.server,
      status: 'error',
      error,
    });
    return { ok: false, count: 0, error };
  }

  if (items.length) {
    await deps.convexMutation(mcpApi.upsertItems, {
      userId,
      connectionId,
      server: row.server,
      items,
    });
  }
  await deps.convexMutation(mcpApi.setSyncState, {
    userId,
    connectionId,
    server: row.server,
    status: 'ready',
    lastSyncedAt: Date.now(),
    itemCount: items.length,
  });
  return { ok: true, count: items.length };
}

export async function syncAllMcpConnections(
  userId: string,
  deps: SyncConnectionDeps = defaultDeps,
): Promise<{ connections: number; items: number }> {
  const connections = (await deps.listUserConnections(userId)).filter(
    (c): c is McpConnectionRow => c.status === 'connected',
  );
  let items = 0;
  for (const connection of connections) {
    const result = await syncConnection(userId, connection.connectionId, deps).catch(() => ({
      ok: false,
      count: 0,
    }));
    items += result.count || 0;
  }
  return { connections: connections.length, items };
}
