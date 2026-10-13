import { z } from 'zod';
import { readJiraIssue, searchAtlassianLive } from '@/lib/mcp/atlassian';
import { getConnectionToken, listUserConnections, type McpConnectionRow } from '@/lib/mcp/connections';
import { truncateText } from '@/lib/shared/text';
import { defineTool } from './registry';

// Live Jira and Confluence reads for the assistant. The connected-tool index
// keeps the issues that involve the user and, on a quiet site, the newest
// changes of the team. These tools reach every issue and page the user can
// see, and store nothing. They give no name of another person (Atlassian
// personal data reporting).

const defaultDeps = { listUserConnections, getConnectionToken, searchAtlassianLive, readJiraIssue };

let deps = defaultDeps;

export function __setAtlassianToolDepsForTest(overrides: Partial<typeof defaultDeps> = {}) {
  deps = { ...defaultDeps, ...overrides };
}

function requireUserId(userId: string | null | undefined): string {
  if (!userId) throw new Error('Not authenticated.');
  return userId;
}

const ATLASSIAN_API = 'https://api.atlassian.com';
const NOT_CONNECTED =
  'No Atlassian account is connected for search. The user can add one in Settings > Connections.';

/** The Atlassian sign-ins that the user lets search read. */
async function searchableAccounts(userId: string): Promise<McpConnectionRow[]> {
  const rows = await deps.listUserConnections(userId);
  return rows.filter(
    (row) =>
      row.server === 'jira' &&
      row.authKind === 'oauth' &&
      row.status !== 'disconnected' &&
      row.includeInSearch !== false,
  );
}

function errorText(error: unknown) {
  if ((error as { statusCode?: number })?.statusCode === 401) return 'Reconnect Atlassian in Settings.';
  return truncateText(String((error as Error)?.message || 'Atlassian request failed'), 300);
}

async function accountToken(userId: string, row: McpConnectionRow) {
  const credentials = await deps.getConnectionToken(userId, row.connectionId);
  if (!credentials) throw Object.assign(new Error('sign-in expired'), { statusCode: 401 });
  return { baseUrl: credentials.row.serverUrl || ATLASSIAN_API, token: credentials.token };
}

export const atlassianSearch = defineTool({
  name: 'atlassian_search',
  description:
    'Search Jira and Confluence live: every issue and page that the user can see on each connected Atlassian site. Results are not stored. Pass query for plain words (it searches both products; an issue key such as STAT-12 finds that issue). Pass jql for a Jira filter, for example "project = STAT AND statusCategory != Done ORDER BY updated DESC" or "assignee = currentUser()". Jira needs a JQL with a restriction, not only ORDER BY. Pass cql for a Confluence filter. Use this, not mcp_search, for any Jira or Confluence question that the recent indexed items do not answer. Results give no names of people. Pass the key of a result to jira_read_issue for the full description and comments.',
  category: 'mcp',
  mutating: false,
  input: z.object({
    query: z.string().optional().describe('Plain words, or one issue key.'),
    jql: z.string().optional().describe('A complete JQL query for Jira.'),
    cql: z.string().optional().describe('A complete CQL query for Confluence.'),
    product: z.enum(['jira', 'confluence']).optional().describe('Omit to search both products.'),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  output: z.object({ items: z.array(z.any()), sites: z.array(z.any()), note: z.string().optional() }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    if (!args.query?.trim() && !args.jql?.trim() && !args.cql?.trim()) {
      return { items: [], sites: [], note: 'Pass query, jql, or cql.' };
    }
    const accounts = await searchableAccounts(userId);
    if (!accounts.length) return { items: [], sites: [], note: NOT_CONNECTED };
    const results = await Promise.all(
      accounts.map(async (row) => {
        try {
          const found = await deps.searchAtlassianLive({
            ...(await accountToken(userId, row)),
            query: args.query,
            jql: args.jql,
            cql: args.cql,
            product: args.product,
            limit: args.limit,
          });
          return { row, found, error: undefined };
        } catch (error) {
          return { row, found: undefined, error: errorText(error) };
        }
      }),
    );
    const items = results
      .flatMap(({ row, found }) =>
        (found?.items || []).map((item) => ({
          server: 'jira',
          product: item.kind === 'page' ? 'Confluence' : 'Jira',
          kind: item.kind,
          connectionId: row.connectionId,
          site: item.organization ?? null,
          key: (item.raw as { key?: string } | undefined)?.key ?? null,
          title: item.title,
          summary: item.summary ? truncateText(item.summary, 600) : null,
          state: item.state ?? null,
          assignedToUser: Boolean(item.assignedToUser),
          url: item.url ?? null,
          updatedAt: item.updatedAtSource ?? null,
          updatedAtIso: item.updatedAtSource ? new Date(item.updatedAtSource).toISOString() : null,
        })),
      )
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return {
      items: items.slice(0, args.limit),
      sites: results.flatMap(
        ({ row, found, error }): Array<Record<string, unknown>> =>
          error
            ? [{ connectionId: row.connectionId, ok: false, error }]
            : (found?.sources || []).map((source) => ({ connectionId: row.connectionId, ...source })),
      ),
    };
  },
});

const ISSUE_KEY = /[A-Za-z][A-Za-z0-9_]*-\d+/u;

/** The issue key and the site of an issue link ("https://x.atlassian.net/browse/KEY-1"). */
function parseIssueLink(value: string): { key: string; siteUrl: string } | null {
  try {
    const url = new URL(value);
    const key =
      url.pathname.match(new RegExp(`/browse/(${ISSUE_KEY.source})`, 'u'))?.[1] ||
      url.searchParams.get('selectedIssue')?.match(new RegExp(`^${ISSUE_KEY.source}$`, 'u'))?.[0];
    return key ? { key, siteUrl: url.origin } : null;
  } catch {
    return null;
  }
}

export const jiraReadIssue = defineTool({
  name: 'jira_read_issue',
  description:
    'Read one Jira issue live from a connected Atlassian site: status, project, type, priority, labels, due date, parent, subtasks, the full description, and the 10 newest comments (oldest first). Pass key (for example STAT-12) from an atlassian_search or mcp_search item, or an issue link as url. The result gives no names of people: assignedToUser and fromUser mark the user, and hasAssignee says that another person has the issue.',
  category: 'mcp',
  mutating: false,
  input: z.object({
    key: z.string().optional().describe('The issue key, such as STAT-12.'),
    url: z.string().optional().describe('A Jira issue link.'),
    connectionId: z.string().optional(),
  }),
  output: z.object({ ok: z.boolean(), issue: z.any().optional(), error: z.string().optional() }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const link = args.url ? parseIssueLink(args.url) : null;
    const key = (args.key?.trim() || link?.key || '').toUpperCase();
    if (!new RegExp(`^${ISSUE_KEY.source}$`, 'u').test(key)) {
      return { ok: false, error: 'Pass an issue key such as STAT-12, or a Jira issue link.' };
    }
    const all = await searchableAccounts(userId);
    const accounts = args.connectionId ? all.filter((row) => row.connectionId === args.connectionId) : all;
    if (!accounts.length) {
      return { ok: false, error: all.length ? 'No connected Atlassian account has that id.' : NOT_CONNECTED };
    }
    let failure: string | undefined;
    for (const row of accounts) {
      try {
        const issue = await deps.readJiraIssue({
          ...(await accountToken(userId, row)),
          key,
          siteUrl: link?.siteUrl,
        });
        if (!issue) continue;
        return {
          ok: true,
          issue: {
            ...issue,
            connectionId: row.connectionId,
            createdAtIso: issue.createdAt ? new Date(issue.createdAt).toISOString() : null,
            updatedAtIso: issue.updatedAt ? new Date(issue.updatedAt).toISOString() : null,
            comments: issue.comments.map((comment) => ({
              ...comment,
              createdAtIso: comment.createdAt ? new Date(comment.createdAt).toISOString() : null,
            })),
          },
        };
      } catch (error) {
        failure ??= errorText(error);
      }
    }
    return { ok: false, error: failure || `No connected Jira site has the issue ${key}.` };
  },
});
