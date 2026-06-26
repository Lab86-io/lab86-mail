import { z } from 'zod';
import { api, convexQuery } from '@/lib/hosted/convex';
import { defineTool } from './registry';

const mcpApi = (api as any).mcp;

function requireUserId(userId: string | null | undefined): string {
  if (!userId) throw new Error('Not authenticated.');
  return userId;
}

const serverEnum = z.enum(['github', 'jira', 'slack']);

export const mcpSearch = defineTool({
  name: 'mcp_search',
  description:
    "Search the user's connected MCP sources (GitHub, Jira, Slack) for items — issues, pull requests, tickets, messages — by text. Only searches connections the user enabled for search. Returns items with title, source, state, url, and updated time.",
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
    const items = await convexQuery<any[]>(mcpApi.searchItems, {
      userId,
      query: args.query,
      server: args.server,
      limit: args.limit,
    });
    return { items: (items || []).map(toToolItem) };
  },
});

export const mcpListItems = defineTool({
  name: 'mcp_list_items',
  description:
    "List the user's most recently updated items from connected MCP sources (GitHub/Jira/Slack) that are enabled for the brief. Use to see open issues, PRs awaiting review, assigned tickets, and recent mentions across tools.",
  category: 'mcp',
  mutating: false,
  input: z.object({ limit: z.number().int().min(1).max(50).default(25) }),
  output: z.object({ items: z.array(z.any()) }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const items = await convexQuery<any[]>(mcpApi.listItemsForBrief, { userId, limit: args.limit });
    return { items: (items || []).map(toToolItem) };
  },
});

function toToolItem(row: any) {
  return {
    server: row.server,
    kind: row.kind,
    title: row.title,
    state: row.state ?? null,
    author: row.author ?? null,
    url: row.url ?? null,
    updatedAt: row.updatedAtSource ?? row.updatedAt ?? null,
    connectionId: row.connectionId,
  };
}
