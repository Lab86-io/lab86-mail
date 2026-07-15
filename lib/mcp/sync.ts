import { api, convexMutation } from '@/lib/hosted/convex';
import { loadBitbucketItems } from './bitbucket';
import { callMcpTool, connectMcp, type McpClientHandle } from './client';
import { getConnectionToken, listUserConnections, type McpConnectionRow } from './connections';
import { loadGitHubItems } from './github';
import {
  granolaAccountInfo,
  granolaMeetingCountHint,
  granolaMeetingDetailArgs,
  mergeGranolaMeetingDetails,
} from './granola';
import { getServerDef, type NormalizedMcpItem, normalizeItems, resolveMcpConnectionConfig } from './servers';

const mcpApi = (api as any).mcp;
const UPSERT_BATCH_SIZE = 100;

export interface SyncConnectionDeps {
  getConnectionToken: typeof getConnectionToken;
  listUserConnections: typeof listUserConnections;
  convexMutation: typeof convexMutation;
  loadBitbucketItems: typeof loadBitbucketItems;
  loadGitHubItems: typeof loadGitHubItems;
  connectMcp: typeof connectMcp;
  callMcpTool: typeof callMcpTool;
}

const defaultDeps: SyncConnectionDeps = {
  getConnectionToken,
  listUserConnections,
  convexMutation,
  loadBitbucketItems,
  loadGitHubItems,
  connectMcp,
  callMcpTool,
};

function classifyError(err: unknown): string {
  const code = Number((err as { statusCode?: number; code?: number })?.statusCode ?? (err as any)?.code);
  if (code === 401 || code === 403) return 'auth rejected — reconnect with a valid token';
  return String((err as { message?: string })?.message || 'sync failed').slice(0, 200);
}

async function upsertItemsInBatches(
  deps: SyncConnectionDeps,
  args: { userId: string; connectionId: string; server: McpConnectionRow['server'] },
  items: NormalizedMcpItem[],
) {
  for (let start = 0; start < items.length; start += UPSERT_BATCH_SIZE) {
    await deps.convexMutation(mcpApi.upsertItems, {
      ...args,
      items: items.slice(start, start + UPSERT_BATCH_SIZE),
    });
  }
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
  const config = resolveMcpConnectionConfig(row.server, row.serverUrl, row.scopes);
  const connection = { ...row, serverUrl: config.serverUrl, scopes: config.scopes };

  if (config.migrated) {
    try {
      await deps.convexMutation(mcpApi.updateConnectionConfig, {
        userId,
        connectionId,
        server: row.server,
        serverUrl: config.serverUrl,
        scopes: config.scopes,
      });
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

  await deps.convexMutation(mcpApi.setSyncState, {
    userId,
    connectionId,
    server: row.server,
    status: 'syncing',
  });

  if (def.transport === 'bitbucket-rest' || def.transport === 'github-rest') {
    try {
      const result =
        def.transport === 'github-rest'
          ? await deps.loadGitHubItems(connection.serverUrl, token)
          : await deps.loadBitbucketItems(connection.serverUrl, token);
      if (result.items.length) {
        await upsertItemsInBatches(deps, { userId, connectionId, server: row.server }, result.items);
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
    handle = await deps.connectMcp(connection.serverUrl, token, def.authMode);
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

  let items: NormalizedMcpItem[] = [];
  const seen = new Set<string>();
  let supportedQueries = 0;
  let successfulQueries = 0;
  const queryErrors: string[] = [];
  let accountInfo: { email?: string; workspaceName?: string } = {};
  try {
    if (row.server === 'granola' && handle.toolNames.has('get_account_info')) {
      try {
        accountInfo = granolaAccountInfo(await deps.callMcpTool(handle, 'get_account_info', {}));
      } catch (err) {
        queryErrors.push(`account check: ${classifyError(err)}`);
      }
    }
    for (const query of def.syncQueries) {
      // Skip tools the server doesn't actually expose (graceful vendor drift).
      if (handle.toolNames.size && !handle.toolNames.has(query.tool)) continue;
      supportedQueries += 1;
      try {
        const result = await deps.callMcpTool(handle, query.tool, query.args);
        const normalized = normalizeItems(query, result);
        const advertisedCount = row.server === 'granola' ? granolaMeetingCountHint(result) : null;
        if (advertisedCount && normalized.length === 0) {
          queryErrors.push(`Granola returned ${advertisedCount} meetings in an unsupported response shape`);
          continue;
        }
        successfulQueries += 1;
        for (const item of normalized) {
          if (seen.has(item.externalId)) continue;
          seen.add(item.externalId);
          items.push(item);
        }
      } catch (err) {
        queryErrors.push(classifyError(err));
      }
    }
    if (row.server === 'granola' && handle.toolNames.has('get_meetings')) {
      const ids = items
        .filter((item) => item.kind === 'meeting')
        .map((item) => item.externalId)
        .slice(0, 30);
      const detailArgs = granolaMeetingDetailArgs(handle.toolSchemas?.get('get_meetings'), ids);
      if (detailArgs) {
        try {
          const result = await deps.callMcpTool(handle, 'get_meetings', detailArgs);
          const detailed = normalizeItems(
            { tool: 'get_meetings', args: detailArgs, kind: 'meeting' },
            result,
          );
          items = mergeGranolaMeetingDetails(items, detailed);
        } catch (err) {
          queryErrors.push(classifyError(err));
        }
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
    await upsertItemsInBatches(deps, { userId, connectionId, server: row.server }, items);
  }
  await deps.convexMutation(mcpApi.setSyncState, {
    userId,
    connectionId,
    server: row.server,
    status: 'ready',
    lastSyncedAt: Date.now(),
    itemCount: items.length,
    accountEmail: accountInfo.email,
    workspaceName: accountInfo.workspaceName,
  });
  return { ok: true, count: items.length };
}

export async function syncAllMcpConnections(
  userId: string,
  deps: SyncConnectionDeps = defaultDeps,
): Promise<{ connections: number; items: number }> {
  const connections = (await deps.listUserConnections(userId)).filter(
    (c): c is McpConnectionRow => c.status === 'connected' || c.status === 'error',
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
