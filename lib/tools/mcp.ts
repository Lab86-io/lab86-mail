import { z } from 'zod';
import { recordOperation } from '@/lib/ai/operations';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { defineTool } from './registry';
import { resolveBoardAndColumn } from './tasks';

const mcpApi = (api as any).mcp;
const boardsApi = (api as any).boards;

const defaultDeps = {
  convexQuery,
  convexMutation,
  resolveBoardAndColumn,
  recordOperation,
};

let deps = defaultDeps;

export function __setMcpToolDepsForTest(overrides: Partial<typeof defaultDeps> = {}) {
  deps = { ...defaultDeps, ...overrides };
}

function requireUserId(userId: string | null | undefined): string {
  if (!userId) throw new Error('Not authenticated.');
  return userId;
}

const serverEnum = z.enum(['github', 'bitbucket', 'jira', 'slack', 'granola']);

export const mcpSearch = defineTool({
  name: 'mcp_search',
  description:
    "Search the user's connected sources (GitHub, Granola, Bitbucket, Atlassian/Jira, Slack) for items — issues, pull requests, meetings, tickets, messages — by text. Only searches connections the user enabled for search. Returns items with title, source, state, url, and updated time.",
  category: 'mcp',
  mutating: false,
  input: z.object({
    query: z.string(),
    server: serverEnum.optional().describe('Restrict to one source.'),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  output: z.object({ items: z.array(z.any()) }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const items = await deps.convexQuery<any[]>(mcpApi.searchItems, {
      userId,
      query: args.query,
      server: args.server,
      limit: args.limit,
    });
    return { items: (items || []).map(toToolItem) };
  },
});

export const githubSearch = defineTool({
  name: 'github_search',
  description:
    "Search the user's connected GitHub issues, pull requests, commits, Projects, and Project items. Use repository and kind filters when the user names a repo or asks for commit/project evidence. Results are read-only evidence and never prove that a goal is complete by themselves.",
  category: 'mcp',
  mutating: false,
  input: z.object({
    query: z.string().min(1),
    repository: z.string().optional().describe('Exact owner/repository name, such as Lab86-io/lab86-mail.'),
    organization: z.string().optional(),
    kind: z.enum(['issue', 'pull_request', 'commit', 'project', 'project_item']).optional(),
    state: z.string().optional(),
    limit: z.number().int().min(1).max(50).default(25),
  }),
  output: z.object({ items: z.array(z.any()) }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const items = await deps.convexQuery<any[]>(mcpApi.searchItems, {
      userId,
      query: args.query,
      server: 'github',
      repository: args.repository,
      organization: args.organization,
      kind: args.kind,
      state: args.state,
      limit: args.limit,
    });
    return { items: (items || []).map(toToolItem) };
  },
});

export const mcpListItems = defineTool({
  name: 'mcp_list_items',
  description:
    "List the user's most recently updated items from connected sources (GitHub/Granola/Bitbucket/Atlassian/Jira/Slack) that are enabled for the brief. Results include the indexed summary/notes and an ISO timestamp when available. Use to see meetings, open issues, PRs awaiting review, assigned tickets, and recent mentions across tools.",
  category: 'mcp',
  mutating: false,
  input: z.object({
    server: serverEnum.optional().describe('Restrict to one source. Use this for latest Granola meeting.'),
    limit: z.number().int().min(1).max(50).default(25),
  }),
  output: z.object({ items: z.array(z.any()) }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const items = await deps.convexQuery<any[]>(mcpApi.listItemsForBrief, {
      userId,
      server: args.server,
      limit: args.limit,
    });
    return { items: (items || []).map(toToolItem) };
  },
});

export const mcpConnectionStatus = defineTool({
  name: 'mcp_connection_status',
  description:
    'Inspect whether connected sources actually synced, including indexed item counts and Granola account/workspace identity. Use after an empty source-specific search instead of guessing that the source is disconnected.',
  category: 'mcp',
  mutating: false,
  input: z.object({ server: serverEnum.optional().describe('Restrict to one source.') }),
  output: z.object({ connections: z.array(z.any()) }),
  async handler(args, ctx) {
    const rows = await deps.convexQuery<any[]>(mcpApi.listConnections, {
      userId: requireUserId(ctx.userId),
    });
    return {
      connections: (rows || [])
        .filter((row) => !args.server || row.server === args.server)
        .map((row) => ({
          server: row.server,
          displayName: row.displayName,
          status: row.status,
          syncStatus: row.syncStatus,
          itemCount: row.itemCount ?? 0,
          lastSyncedAt: row.lastSyncedAt,
          includeInSearch: row.includeInSearch,
          accountEmail: row.accountEmail,
          workspaceName: row.workspaceName,
          error: row.syncError || row.error,
        })),
    };
  },
});

export const mcpCreateTask = defineTool({
  name: 'mcp_create_task',
  description:
    'Create a Lab86 task from a connected-tool item (a GitHub issue/PR, Bitbucket PR, Jira ticket, or Slack message). Pass the item identifiers from mcp_search/mcp_list_items. The card carries a provenance link back to the source, and when the source later closes/merges/resolves the task auto-completes. Defaults to the user’s default board, first column.',
  category: 'mcp',
  mutating: true,
  input: z.object({
    connectionId: z.string(),
    externalId: z.string(),
    server: serverEnum,
    title: z.string().min(1),
    url: z.string().optional(),
    boardId: z.string().optional(),
    column: z.string().optional(),
  }),
  output: z.object({ ok: z.boolean(), cardId: z.string(), operationId: z.string() }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const { board, column } = await deps.resolveBoardAndColumn(userId, args.boardId, args.column);
    const cardId = await deps.convexMutation<string>(boardsApi.createCard, {
      userId,
      boardId: board.boardId,
      columnId: column.columnId,
      title: args.title,
      source: {
        kind: 'mcp',
        server: args.server,
        connectionId: args.connectionId,
        externalId: args.externalId,
        url: args.url,
        title: args.title,
      },
    });
    // Record the link so a future sync can auto-complete this card when the
    // source item closes.
    await deps.convexMutation(mcpApi.linkTask, {
      userId,
      connectionId: args.connectionId,
      server: args.server,
      externalId: args.externalId,
      cardId,
    });
    const operationId = await deps.recordOperation({
      userId,
      tool: 'mcp_create_task',
      surface: 'tasks',
      summary: `Added "${args.title}" to ${column.name} on "${board.title}" from ${args.server}`,
      target: { kind: 'card', id: cardId, boardId: board.boardId },
      inverse: { kind: 'tasks.delete_card', payload: { cardId } },
    });
    return { ok: true, cardId, operationId };
  },
});

function toToolItem(row: any) {
  const updatedAt = row.updatedAtSource ?? row.updatedAt ?? null;
  return {
    server: row.server,
    kind: row.kind,
    title: row.title,
    summary: row.summary ?? null,
    state: row.state ?? null,
    author: row.author ?? null,
    repository: row.repository ?? null,
    organization: row.organization ?? null,
    parentExternalId: row.parentExternalId ?? null,
    sha: row.sha ?? null,
    url: row.url ?? null,
    updatedAt,
    updatedAtIso:
      typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? new Date(updatedAt).toISOString() : null,
    connectionId: row.connectionId,
    // Needed to create/link a task from this item.
    externalId: row.externalId,
  };
}
