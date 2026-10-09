import { z } from 'zod';
import { getConnectionToken, listUserConnections, type McpConnectionRow } from '@/lib/mcp/connections';
import { parseSlackPermalink, readSlackThread, searchSlackLive } from '@/lib/mcp/slack';
import { truncateText } from '@/lib/shared/text';
import { defineTool } from './registry';

// Live Slack reads for the assistant. The connected-tool index keeps only the
// mentions and direct messages for the Brief; these tools reach everything
// the user can see in each connected workspace, and store nothing.

const defaultDeps = { listUserConnections, getConnectionToken, searchSlackLive, readSlackThread };

let deps = defaultDeps;

export function __setSlackToolDepsForTest(overrides: Partial<typeof defaultDeps> = {}) {
  deps = { ...defaultDeps, ...overrides };
}

function requireUserId(userId: string | null | undefined): string {
  if (!userId) throw new Error('Not authenticated.');
  return userId;
}

const SLACK_API = 'https://slack.com/api';

/** The Slack workspaces connected with a sign-in that the user lets search read. */
async function searchableWorkspaces(userId: string): Promise<McpConnectionRow[]> {
  const rows = await deps.listUserConnections(userId);
  return rows.filter(
    (row) =>
      row.server === 'slack' &&
      row.authKind === 'oauth' &&
      row.status !== 'disconnected' &&
      row.includeInSearch !== false,
  );
}

function workspaceLabel(row: McpConnectionRow) {
  return row.workspaceName || row.displayName || 'Slack';
}

function errorText(error: unknown) {
  const message = String((error as Error)?.message || 'Slack request failed');
  if (/rate limit/i.test(message)) return 'Slack asked the app to wait. Try again in a minute.';
  if ((error as { statusCode?: number })?.statusCode === 401) return 'Reconnect this workspace in Settings.';
  return truncateText(message, 200);
}

function matchesWorkspace(row: McpConnectionRow, workspace: string) {
  const wanted = workspace.trim().toLowerCase();
  return row.connectionId.toLowerCase() === wanted || workspaceLabel(row).toLowerCase().includes(wanted);
}

export const slackSearch = defineTool({
  name: 'slack_search',
  description:
    'Search Slack live, across every connected workspace: public channels, private channels, direct messages, and group messages that the user can see. Use Slack search syntax in the query (from:@name, in:#channel, to:me, before:/after:YYYY-MM-DD, "exact phrase"). Results are not stored. Each item has connectionId, channel, and ts; pass them to slack_read_thread to read the whole thread. Use this, not mcp_search, for any question about Slack messages beyond the user\'s recent mentions.',
  category: 'mcp',
  mutating: false,
  input: z.object({
    query: z.string().min(1),
    workspace: z
      .string()
      .optional()
      .describe('A workspace name or connectionId. Omit to search every connected workspace.'),
    sort: z.enum(['relevance', 'newest']).default('relevance'),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  output: z.object({ items: z.array(z.any()), workspaces: z.array(z.any()), note: z.string().optional() }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const all = await searchableWorkspaces(userId);
    const selected = args.workspace ? all.filter((row) => matchesWorkspace(row, args.workspace!)) : all;
    if (!selected.length) {
      return {
        items: [],
        workspaces: [],
        note: all.length
          ? `No connected Slack workspace matches "${args.workspace}".`
          : 'No Slack workspace is connected for search. The user can add one in Settings > Connections.',
      };
    }
    const results = await Promise.all(
      selected.map(async (row) => {
        try {
          const credentials = await deps.getConnectionToken(userId, row.connectionId);
          if (!credentials) throw Object.assign(new Error('sign-in expired'), { statusCode: 401 });
          const found = await deps.searchSlackLive({
            baseUrl: credentials.row.serverUrl || SLACK_API,
            token: credentials.token,
            query: args.query,
            count: args.limit,
            sort: args.sort,
          });
          return { row, found, error: undefined };
        } catch (error) {
          return { row, found: undefined, error: errorText(error) };
        }
      }),
    );
    // Relevance keeps each workspace's own order and takes turns; newest
    // sorts every match by time.
    const lists = results.map(({ row, found }) =>
      (found?.items || []).map((item) => {
        const raw = (item.raw || {}) as { channel?: string; channelName?: string; ts?: string };
        return {
          server: 'slack',
          connectionId: row.connectionId,
          workspace: found?.workspaceName || workspaceLabel(row),
          title: item.title,
          summary: item.summary ?? null,
          author: item.author ?? null,
          url: item.url ?? null,
          channel: raw.channel ?? null,
          channelName: raw.channelName ?? null,
          ts: raw.ts ?? null,
          updatedAt: item.updatedAtSource ?? null,
          updatedAtIso: item.updatedAtSource ? new Date(item.updatedAtSource).toISOString() : null,
        };
      }),
    );
    let items: Array<(typeof lists)[number][number]> = [];
    if (args.sort === 'newest') {
      items = lists.flat().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    } else {
      for (let index = 0; items.length < args.limit * lists.length; index += 1) {
        const round = lists.map((list) => list[index]).filter((item) => item !== undefined);
        if (!round.length) break;
        items.push(...round);
      }
    }
    return {
      items: items.slice(0, args.limit),
      workspaces: results.map(({ row, found, error }) => ({
        connectionId: row.connectionId,
        name: found?.workspaceName || workspaceLabel(row),
        ok: !error,
        total: found?.total ?? null,
        ...(error ? { error } : {}),
      })),
    };
  },
});

export const slackReadThread = defineTool({
  name: 'slack_read_thread',
  description:
    'Read a whole Slack thread (up to 15 messages, oldest first) live from a connected workspace. Pass connectionId, channel, and ts from a slack_search item, or a Slack message link as permalink. Slack lets this app read a thread about once a minute, so read only the threads that the answer needs.',
  category: 'mcp',
  mutating: false,
  input: z.object({
    connectionId: z.string().optional(),
    channel: z.string().optional(),
    ts: z.string().optional(),
    permalink: z.string().optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    workspace: z.string().optional(),
    url: z.string().optional(),
    messages: z.array(z.any()).optional(),
    hasMore: z.boolean().optional(),
    error: z.string().optional(),
  }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const link = args.permalink ? parseSlackPermalink(args.permalink) : null;
    const channel = args.channel || link?.channel;
    const ts = link?.threadTs || args.ts || link?.ts;
    if (!channel || !ts) {
      return { ok: false, error: 'Pass channel and ts from a slack_search item, or a Slack message link.' };
    }
    const all = await searchableWorkspaces(userId);
    const row = args.connectionId
      ? all.find((entry) => entry.connectionId === args.connectionId)
      : all.length === 1
        ? all[0]
        : undefined;
    if (!row) {
      return {
        ok: false,
        error: all.length
          ? 'Pass the connectionId of the workspace from the slack_search item.'
          : 'No Slack workspace is connected for search.',
      };
    }
    try {
      const credentials = await deps.getConnectionToken(userId, row.connectionId);
      if (!credentials) throw Object.assign(new Error('sign-in expired'), { statusCode: 401 });
      const thread = await deps.readSlackThread({
        baseUrl: credentials.row.serverUrl || SLACK_API,
        token: credentials.token,
        channel,
        ts,
      });
      return {
        ok: true,
        workspace: workspaceLabel(row),
        ...(args.permalink ? { url: args.permalink } : {}),
        messages: thread.messages,
        hasMore: thread.hasMore,
      };
    } catch (error) {
      return { ok: false, workspace: workspaceLabel(row), error: errorText(error) };
    }
  },
});
