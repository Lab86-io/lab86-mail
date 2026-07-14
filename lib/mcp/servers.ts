// Registry of the remote MCP servers we support, plus a defensive normalizer
// that turns whatever a tool returns into uniform items. Tool names/args are
// the documented defaults for each vendor's hosted MCP server; sync is
// best-effort and skips any tool a server doesn't actually expose, so a vendor
// renaming a tool degrades gracefully instead of crashing the run.
import type { McpAuthMode } from './auth';

export type McpServerId = 'github' | 'bitbucket' | 'jira' | 'slack';
export type McpServerTransport = 'mcp' | 'bitbucket-rest' | 'github-rest';

export interface McpSyncQuery {
  tool: string;
  args: Record<string, unknown>;
  kind: string;
}

export interface McpServerDef {
  id: McpServerId;
  label: string;
  transport: McpServerTransport;
  authMode: McpAuthMode;
  // Hosted Streamable-HTTP MCP endpoints for MCP transports; REST API base URL
  // for direct API transports.
  defaultUrl: string;
  tokenLabel: string;
  tokenHelp: string;
  scopes: string[];
  syncQueries: McpSyncQuery[];
}

export const MCP_SERVERS: Record<McpServerId, McpServerDef> = {
  github: {
    id: 'github',
    label: 'GitHub',
    transport: 'github-rest',
    authMode: 'bearer',
    defaultUrl: 'https://api.github.com',
    tokenLabel: 'GitHub personal access token',
    tokenHelp:
      'Create a fine-grained PAT with read access to metadata, contents, issues, pull requests, and Projects at github.com/settings/tokens.',
    scopes: ['metadata:read', 'contents:read', 'issues:read', 'pull_requests:read', 'projects:read'],
    syncQueries: [],
  },
  bitbucket: {
    id: 'bitbucket',
    label: 'Bitbucket',
    transport: 'bitbucket-rest',
    authMode: 'basic-or-bearer',
    defaultUrl: 'https://api.bitbucket.org/2.0',
    tokenLabel: 'Bitbucket token',
    tokenHelp:
      'Paste email:api_token from your Atlassian account, or a Bitbucket access token. Needs repository and pull request read access.',
    scopes: ['repository:read', 'pullrequest:read'],
    syncQueries: [],
  },
  jira: {
    id: 'jira',
    label: 'Atlassian / Jira',
    transport: 'mcp',
    authMode: 'basic-or-bearer',
    defaultUrl: 'https://mcp.atlassian.com/v1/mcp',
    tokenLabel: 'Atlassian token',
    tokenHelp:
      'Paste email:api_token for an Atlassian API token, or a Rovo service API key. Your org admin may need to enable headless MCP access.',
    scopes: ['read:jira-work'],
    syncQueries: [
      {
        tool: 'searchJiraIssuesUsingJql',
        args: {
          jql: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC',
          maxResults: 30,
        },
        kind: 'ticket',
      },
    ],
  },
  slack: {
    id: 'slack',
    label: 'Slack',
    transport: 'mcp',
    authMode: 'bearer',
    defaultUrl: 'https://mcp.slack.com/mcp',
    tokenLabel: 'Slack token',
    tokenHelp:
      'Connect via a Slack token with search scope. Your workspace admin must approve the Slack MCP integration first.',
    scopes: ['search:read'],
    syncQueries: [{ tool: 'search_messages', args: { query: 'is:mention', count: 30 }, kind: 'message' }],
  },
};

export function getServerDef(id: string): McpServerDef | null {
  return (MCP_SERVERS as Record<string, McpServerDef>)[id] ?? null;
}

export interface NormalizedMcpItem {
  externalId: string;
  kind: string;
  title: string;
  summary?: string;
  url?: string;
  state?: string;
  author?: string;
  repository?: string;
  organization?: string;
  parentExternalId?: string;
  sha?: string;
  assignedToUser?: boolean;
  updatedAtSource?: number;
  raw?: unknown;
  searchText: string;
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000;
  if (typeof value === 'string') {
    const t = Date.parse(value);
    if (!Number.isNaN(t)) return t;
    const n = Number(value);
    if (Number.isFinite(n)) return n > 1e12 ? n : n * 1000;
  }
  return undefined;
}

// Pull an array of raw records out of whatever the MCP tool returned, preferring
// machine-readable structuredContent over text content.
function extractRawArray(result: any): any[] {
  const candidates: any[] = [];
  const sc = result?.structuredContent ?? result?.structured_content;
  if (sc) candidates.push(sc);
  for (const block of result?.content ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      try {
        candidates.push(JSON.parse(block.text));
      } catch {
        // non-JSON text block — ignore
      }
    }
  }
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
    for (const key of ['items', 'issues', 'results', 'messages', 'pull_requests', 'matches', 'data']) {
      if (Array.isArray(c?.[key])) return c[key];
    }
    // Slack search nests under messages.matches
    if (Array.isArray(c?.messages?.matches)) return c.messages.matches;
  }
  return [];
}

export function normalizeItems(query: McpSyncQuery, result: any): NormalizedMcpItem[] {
  const rows = extractRawArray(result);
  const out: NormalizedMcpItem[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const externalId = firstString(
      // Prefer globally-unique identifiers. GitHub reuses `number` across issues
      // AND pull requests in the same repo, so issue #42 and PR #42 would
      // collide and overwrite each other in mcpItems — fall back to `number`
      // only after the unique fields (internal id, Jira key, distinct
      // issue/pull url).
      row.id,
      row.key,
      row.html_url,
      row.url,
      row.permalink,
      row.self,
      row.number,
      row.iid,
      row.ts,
    );
    if (!externalId) continue;
    const title = firstString(
      row.title,
      row.summary,
      row.name,
      row.fields?.summary,
      row.text,
      row.message?.text,
    );
    const url = firstString(row.html_url, row.url, row.permalink, row.self, row.link);
    const state = firstString(
      row.state,
      row.status,
      row.fields?.status?.name,
      row.fields?.statusCategory?.name,
    );
    const author = firstString(
      row.user?.login,
      row.author?.login,
      row.author?.displayName,
      row.creator?.displayName,
      row.fields?.reporter?.displayName,
      row.username,
      row.user,
    );
    const updatedAtSource = parseTimestamp(
      row.updated_at ?? row.updatedAt ?? row.updated ?? row.fields?.updated ?? row.ts,
    );
    const finalTitle = title || `${query.kind} ${externalId}`;
    out.push({
      externalId,
      kind: query.kind,
      title: finalTitle,
      url,
      state,
      author,
      updatedAtSource,
      raw: row,
      searchText: [finalTitle, state, author, query.kind].filter(Boolean).join(' '),
    });
  }
  return out;
}
