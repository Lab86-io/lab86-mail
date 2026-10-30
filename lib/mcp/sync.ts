import { api, convexMutation } from '@/lib/hosted/convex';
import type { OwnerFact } from '@/lib/obligations/rules';
import { stripLoneSurrogatesDeep, truncateText } from '@/lib/shared/text';
import { loadAtlassianItems } from './atlassian';
import { buildAuthorizationHeader } from './auth';
import { loadBitbucketItems } from './bitbucket';
import { callMcpTool, connectMcp, type McpClientHandle } from './client';
import { getConnectionToken, listUserConnections, type McpConnectionRow } from './connections';
import { loadGitHubItems } from './github';
import {
  granolaAccountInfo,
  granolaMeetingCountHint,
  granolaMeetingDetailBatches,
  mergeGranolaMeetingDetails,
} from './granola';
import {
  connectionTransport,
  getServerDef,
  type McpServerTransport,
  type NormalizedMcpItem,
  normalizeItems,
  resolveMcpConnectionConfig,
} from './servers';
import { loadSlackItems } from './slack';

const mcpApi = api.mcp;
const UPSERT_BATCH_SIZE = 100;

// ---------------------------------------------------------------------------
// Needs you (phase 2): what a GitHub or Bitbucket item asks of the owner. The
// facts go into the item's `raw.ownerFacts`; the content index writes them as
// sentences (lib/obligations/rules.ts ownerFactText), so jev_content can label
// a review request, a mention, an assigned issue, or a failed check on the
// owner's branch as actionable for the owner. Only items with a fact change,
// so the other items keep their sync hash.
// ---------------------------------------------------------------------------

export type OwnerFactMap = Map<string, OwnerFact[]>;

const GITHUB_OWNER_FACTS_QUERY = `
query NeedsYouOwnerFacts {
  reviews: search(query: "is:pr is:open review-requested:@me", type: ISSUE, first: 50) { nodes { ...Ref } }
  mentions: search(query: "is:open mentions:@me", type: ISSUE, first: 50) { nodes { ...Ref } }
  assigned: search(query: "is:open assignee:@me", type: ISSUE, first: 50) { nodes { ...Ref } }
  authored: search(query: "is:pr is:open author:@me", type: ISSUE, first: 20) {
    nodes {
      ... on PullRequest {
        number
        repository { nameWithOwner }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}
fragment Ref on SearchResultItem {
  __typename
  ... on PullRequest { number repository { nameWithOwner } }
  ... on Issue { number repository { nameWithOwner } }
}`;

const OWNER_FACT_TIMEOUT_MS = 10_000;

function addFact(map: OwnerFactMap, externalId: string, fact: OwnerFact) {
  const facts = map.get(externalId) ?? [];
  if (!facts.includes(fact)) map.set(externalId, [...facts, fact]);
}

function githubRef(node: any, kind?: 'pull_request' | 'issue') {
  const repository = node?.repository?.nameWithOwner;
  const number = node?.number;
  const type = kind ?? (node?.__typename === 'PullRequest' ? 'pull_request' : 'issue');
  return repository && number ? `github:${type}:${repository}#${number}` : undefined;
}

/** The GraphQL endpoint of a GitHub REST base URL (GitHub Enterprise uses /api/graphql). */
export function githubGraphqlUrl(baseUrl: string) {
  const rest = String(baseUrl || 'https://api.github.com').replace(/\/$/, '');
  return /\/api\/v3$/i.test(rest) ? rest.replace(/\/api\/v3$/i, '/api/graphql') : `${rest}/graphql`;
}

/**
 * The owner facts of GitHub items in one GraphQL call: open review requests,
 * open items that mention the owner or are assigned to the owner, and the
 * owner's open pull requests whose last commit has failed checks.
 */
export async function loadGitHubOwnerFacts(
  baseUrl: string,
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<OwnerFactMap> {
  const response = await fetcher(githubGraphqlUrl(baseUrl), {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'Lab86-Albatross',
    },
    body: JSON.stringify({ query: GITHUB_OWNER_FACTS_QUERY }),
    signal: AbortSignal.timeout(OWNER_FACT_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GitHub owner facts failed with HTTP ${response.status}`);
  const data = ((await response.json()) as any)?.data ?? {};
  const map: OwnerFactMap = new Map();
  const each = (key: string) => (Array.isArray(data[key]?.nodes) ? data[key].nodes : []);
  for (const [key, fact] of [
    ['reviews', 'review_requested'],
    ['mentions', 'mentioned'],
    ['assigned', 'assigned'],
  ] as const)
    for (const node of each(key)) {
      const id = githubRef(node);
      if (id) addFact(map, id, fact);
    }
  for (const node of each('authored')) {
    const state = node?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
    const id = githubRef(node, 'pull_request');
    if (id && (state === 'FAILURE' || state === 'ERROR')) addFact(map, id, 'checks_failed');
  }
  return map;
}

/** Bitbucket pull requests whose build statuses one sync reads: the owner's newest open ones. */
const BITBUCKET_STATUS_LIMIT = 5;

/**
 * The owner facts of Bitbucket items: a failed build status on one of the
 * owner's open pull requests (the loader lists the owner's pull requests).
 * A failed status read is skipped.
 */
export async function loadBitbucketOwnerFacts(
  baseUrl: string,
  token: string,
  items: NormalizedMcpItem[],
  fetcher: typeof fetch = fetch,
): Promise<OwnerFactMap> {
  const map: OwnerFactMap = new Map();
  const open = items
    .filter((item) => item.state === 'open')
    .sort((a, b) => (b.updatedAtSource ?? 0) - (a.updatedAtSource ?? 0))
    .slice(0, BITBUCKET_STATUS_LIMIT);
  for (const item of open) {
    const raw = (item.raw ?? {}) as any;
    const repository = raw.destination?.repository?.full_name || raw.source?.repository?.full_name;
    if (!repository || raw.id === undefined) continue;
    const statusesUrl = `${baseUrl.replace(/\/+$/, '')}/repositories/${repository}/pullrequests/${encodeURIComponent(String(raw.id))}/statuses?pagelen=50`;
    try {
      const response = await fetcher(statusesUrl, {
        headers: {
          accept: 'application/json',
          authorization: buildAuthorizationHeader(token, 'basic-or-bearer'),
        },
        signal: AbortSignal.timeout(OWNER_FACT_TIMEOUT_MS),
      });
      if (!response.ok) continue;
      const page = (await response.json()) as { values?: Array<{ state?: string }> };
      if ((page.values || []).some((status) => status.state === 'FAILED'))
        addFact(map, item.externalId, 'checks_failed');
    } catch {
      // One failed read does not stop the sync.
    }
  }
  return map;
}

/** The items with their owner facts in `raw.ownerFacts`. An item without a fact is unchanged. */
export function withOwnerFacts(items: NormalizedMcpItem[], facts: OwnerFactMap | null): NormalizedMcpItem[] {
  if (!facts?.size) return items;
  return items.map((item) => {
    const found = facts.get(item.externalId);
    if (!found?.length) return item;
    const raw = item.raw && typeof item.raw === 'object' ? (item.raw as Record<string, unknown>) : {};
    return { ...item, raw: { ...raw, ownerFacts: found } };
  });
}

export interface SyncConnectionDeps {
  getConnectionToken: typeof getConnectionToken;
  listUserConnections: typeof listUserConnections;
  convexMutation: typeof convexMutation;
  loadBitbucketItems: typeof loadBitbucketItems;
  loadGitHubItems: typeof loadGitHubItems;
  loadAtlassianItems: typeof loadAtlassianItems;
  loadSlackItems: typeof loadSlackItems;
  connectMcp: typeof connectMcp;
  callMcpTool: typeof callMcpTool;
  /** Needs you owner facts. Left out: the items go as the loader gave them. */
  loadGitHubOwnerFacts?: (baseUrl: string, token: string) => Promise<OwnerFactMap>;
  loadBitbucketOwnerFacts?: (
    baseUrl: string,
    token: string,
    items: NormalizedMcpItem[],
  ) => Promise<OwnerFactMap>;
}

const defaultDeps: SyncConnectionDeps = {
  getConnectionToken,
  listUserConnections,
  convexMutation,
  loadBitbucketItems,
  loadGitHubItems,
  loadAtlassianItems,
  loadSlackItems,
  connectMcp,
  callMcpTool,
  loadGitHubOwnerFacts: (baseUrl, token) => loadGitHubOwnerFacts(baseUrl, token),
  loadBitbucketOwnerFacts: (baseUrl, token, items) => loadBitbucketOwnerFacts(baseUrl, token, items),
};

/**
 * True when the source rejected the saved sign-in (AI-7). A 403 that names a
 * rate limit is a sync problem, not a reason to reconnect.
 */
export function isMcpAuthFailure(err: unknown): boolean {
  const code = Number((err as { statusCode?: number; code?: number })?.statusCode ?? (err as any)?.code);
  if ((err as { name?: string })?.name === 'UnauthorizedError') return true;
  if (code === 401) return true;
  if (code !== 403) return false;
  const message = String((err as { message?: string })?.message || '');
  return !/rate limit|secondary rate|abuse detection/i.test(message);
}

function classifyError(err: unknown, authKind?: string): string {
  if (isMcpAuthFailure(err)) {
    return authKind === 'oauth'
      ? 'sign-in rejected — reconnect to sign in again'
      : 'auth rejected — reconnect with a valid token';
  }
  return truncateText(String((err as { message?: string })?.message || 'sync failed'), 200);
}

/** What a failed step says about the connection: reconnect, or nothing known. */
function failureOutcome(err: unknown) {
  return isMcpAuthFailure(err) ? { outcome: 'reconnect' as const } : {};
}

/** An MCP tool result that reports a failure in-band (isError) instead of throwing. */
export class McpToolResultError extends Error {
  constructor(tool: string, result: unknown) {
    const content = Array.isArray((result as { content?: unknown })?.content)
      ? ((result as { content: Array<{ type?: string; text?: string }> }).content ?? [])
      : [];
    const text = content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join(' ')
      .trim();
    super(`${tool} failed${text ? `: ${text}` : ''}`);
    this.name = 'McpToolResultError';
  }
}

async function callSyncTool(
  deps: SyncConnectionDeps,
  handle: McpClientHandle,
  tool: string,
  args: Record<string, unknown>,
) {
  const result = await deps.callMcpTool(handle, tool, args);
  if ((result as { isError?: unknown })?.isError === true) throw new McpToolResultError(tool, result);
  return result;
}

/**
 * Why no token came back. An OAuth connection whose refresh failed needs the
 * user to sign in again, so say that instead of a credential-storage error.
 */
async function missingTokenState(
  deps: SyncConnectionDeps,
  userId: string,
  connectionId: string,
): Promise<{ server: string; error: string }> {
  const row = await deps
    .listUserConnections(userId)
    .then((rows) => rows.find((entry) => entry.connectionId === connectionId))
    .catch(() => undefined);
  if (!row) return { server: 'unknown', error: 'missing or unreadable credentials' };
  const label = getServerDef(row.server)?.label || row.server;
  return {
    server: row.server,
    error:
      row.authKind === 'oauth'
        ? `Reconnect ${label}: its sign-in expired.`
        : `Reconnect ${label}: its saved credentials cannot be read.`,
  };
}

interface RestLoadResult {
  items: NormalizedMcpItem[];
  /** Part of the sync failed, but the source answered. */
  problems?: string[];
  accountEmail?: string;
  workspaceName?: string;
}

/** One sync of a source that Albatross reads through its REST API. */
async function loadRestItems(
  deps: SyncConnectionDeps,
  transport: Exclude<McpServerTransport, 'mcp'>,
  serverUrl: string,
  token: string,
): Promise<RestLoadResult> {
  switch (transport) {
    case 'github-rest': {
      const result = await deps.loadGitHubItems(serverUrl, token);
      // The owner facts are extra: a failed read keeps the items as they are.
      const facts = (await deps.loadGitHubOwnerFacts?.(serverUrl, token).catch(() => null)) ?? null;
      return { ...result, items: withOwnerFacts(result.items, facts) };
    }
    case 'bitbucket-rest': {
      const result = await deps.loadBitbucketItems(serverUrl, token);
      const facts =
        (await deps.loadBitbucketOwnerFacts?.(serverUrl, token, result.items).catch(() => null)) ?? null;
      return {
        items: withOwnerFacts(result.items, facts),
        workspaceName: result.workspaces?.join(', ') || undefined,
      };
    }
    case 'atlassian-rest':
      return deps.loadAtlassianItems(serverUrl, token);
    case 'slack-rest':
      return deps.loadSlackItems(serverUrl, token);
  }
}

async function upsertItemsInBatches(
  deps: SyncConnectionDeps,
  args: { userId: string; connectionId: string; server: McpConnectionRow['server'] },
  items: NormalizedMcpItem[],
) {
  for (let start = 0; start < items.length; start += UPSERT_BATCH_SIZE) {
    await deps.convexMutation(mcpApi.upsertItems, {
      ...args,
      // Every MCP and REST connector item passes here before Convex; a lone
      // surrogate from provider JSON would reject the whole batch.
      items: stripLoneSurrogatesDeep(items.slice(start, start + UPSERT_BATCH_SIZE)),
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
    const missing = await missingTokenState(deps, userId, connectionId);
    await deps.convexMutation(mcpApi.setSyncState, {
      userId,
      connectionId,
      server: missing.server,
      status: 'error',
      error: missing.error,
      outcome: 'reconnect',
    });
    return { ok: false, count: 0, error: missing.error };
  }
  const { row, token } = resolved;
  const def = getServerDef(row.server);
  if (!def) return { ok: false, count: 0, error: 'unknown server' };
  const config = resolveMcpConnectionConfig(row.server, row.serverUrl, row.scopes, row.authKind);
  const connection = { ...row, serverUrl: config.serverUrl, scopes: config.scopes };
  const transport = connectionTransport(def, row.authKind);

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
      const error = classifyError(err, row.authKind);
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

  if (transport !== 'mcp') {
    try {
      const result = await loadRestItems(deps, transport, connection.serverUrl, token);
      if (result.items.length) {
        await upsertItemsInBatches(deps, { userId, connectionId, server: row.server }, result.items);
      }
      const problem = result.problems?.[0];
      await deps.convexMutation(mcpApi.setSyncState, {
        userId,
        connectionId,
        server: row.server,
        status: problem ? 'error' : 'ready',
        ...(problem ? { error: problem } : {}),
        // The source answered, so the sign-in works even when part of the
        // sync failed (AI-7).
        outcome: 'ok',
        lastSyncedAt: Date.now(),
        itemCount: result.items.length,
        ...(result.accountEmail ? { accountEmail: result.accountEmail } : {}),
        ...(result.workspaceName ? { workspaceName: result.workspaceName } : {}),
      });
      return { ok: !problem, count: result.items.length, ...(problem ? { error: problem } : {}) };
    } catch (err) {
      const error = classifyError(err, row.authKind);
      await deps.convexMutation(mcpApi.setSyncState, {
        userId,
        connectionId,
        server: row.server,
        status: 'error',
        error,
        ...failureOutcome(err),
      });
      return { ok: false, count: 0, error };
    }
  }

  let handle: McpClientHandle;
  try {
    handle = await deps.connectMcp(connection.serverUrl, token, def.authMode);
  } catch (err) {
    const error = classifyError(err, row.authKind);
    await deps.convexMutation(mcpApi.setSyncState, {
      userId,
      connectionId,
      server: row.server,
      status: 'error',
      error,
      ...failureOutcome(err),
    });
    return { ok: false, count: 0, error };
  }

  let items: NormalizedMcpItem[] = [];
  const seen = new Set<string>();
  let supportedQueries = 0;
  let successfulQueries = 0;
  const queryErrors: string[] = [];
  let authFailures = 0;
  const noteQueryError = (err: unknown, prefix = '') => {
    if (isMcpAuthFailure(err)) authFailures += 1;
    queryErrors.push(`${prefix}${classifyError(err, row.authKind)}`);
  };
  let accountInfo: { email?: string; workspaceName?: string } = {};
  try {
    if (row.server === 'granola' && handle.toolNames.has('get_account_info')) {
      try {
        accountInfo = granolaAccountInfo(await callSyncTool(deps, handle, 'get_account_info', {}));
      } catch (err) {
        noteQueryError(err, 'account check: ');
      }
    }
    for (const query of def.syncQueries) {
      // Skip tools the server doesn't actually expose (graceful vendor drift).
      if (handle.toolNames.size && !handle.toolNames.has(query.tool)) continue;
      supportedQueries += 1;
      try {
        const result = await callSyncTool(deps, handle, query.tool, query.args);
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
        noteQueryError(err);
      }
    }
    if (row.server === 'granola' && handle.toolNames.has('get_meetings')) {
      const ids = items
        .filter((item) => item.kind === 'meeting')
        .map((item) => item.externalId)
        .slice(0, 30);
      // get_meetings takes at most 10 ids, so 30 ids go in 3 calls. A failed
      // batch is noted, and the other batches still add their details.
      for (const detailArgs of granolaMeetingDetailBatches(handle.toolSchemas?.get('get_meetings'), ids)) {
        try {
          const result = await callSyncTool(deps, handle, 'get_meetings', detailArgs);
          const detailed = normalizeItems(
            { tool: 'get_meetings', args: detailArgs, kind: 'meeting' },
            result,
          );
          items = mergeGranolaMeetingDetails(items, detailed);
        } catch (err) {
          noteQueryError(err);
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
      ...(authFailures ? { outcome: 'reconnect' as const } : {}),
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
    status: queryErrors.length ? 'error' : 'ready',
    ...(queryErrors.length ? { error: queryErrors[0] } : {}),
    // The source answered at least one query, so the connection works even
    // when part of the sync failed (AI-7).
    outcome: 'ok',
    lastSyncedAt: Date.now(),
    itemCount: items.length,
    accountEmail: accountInfo.email,
    workspaceName: accountInfo.workspaceName,
  });
  return {
    ok: queryErrors.length === 0,
    count: items.length,
    ...(queryErrors.length ? { error: queryErrors[0] } : {}),
  };
}

export async function syncAllMcpConnections(
  userId: string,
  deps: SyncConnectionDeps = defaultDeps,
): Promise<{ connections: number; items: number }> {
  // A reconnect-needed (`error`) row is still tried: a good sync heals it.
  // A connection with the Brief and search toggles both off is not polled
  // (X8): nothing reads its items.
  const connections = (await deps.listUserConnections(userId)).filter(
    (c): c is McpConnectionRow =>
      (c.status === 'connected' || c.status === 'error') &&
      (c.includeInBrief !== false || c.includeInSearch !== false),
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
