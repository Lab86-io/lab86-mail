import { api, convexMutation } from '../hosted/convex';
import { loadAtlassianChangedIssues, loadAtlassianHistoryPage } from '../mcp/atlassian';
import { callMcpTool, connectMcp } from '../mcp/client';
import { getConnectionToken, listUserConnections } from '../mcp/connections';
import { granolaMeetingDetailBatches, mergeGranolaMeetingDetails } from '../mcp/granola';
import { connectionTransport, getServerDef, type NormalizedMcpItem, normalizeItems } from '../mcp/servers';
import { loadSlackChangedMessages, loadSlackHistoryPage } from '../mcp/slack';

/** Expand beyond the Brief's small recent-item feed, but only with pagination
 * parameters the connected server actually advertises. Never report full
 * coverage when the server only exposes a limited search window.
 *
 * The history walk ends. When it reaches the last page it records
 * `complete` in the cursor. After that, the pass runs at most once an hour
 * and takes only new or changed items. Before, the walk started again at the
 * first page, so it indexed the same items again with no end. */
export const HISTORY_RECHECK_MS = 3_600_000;
/** Granola meeting ids the pass keeps after the walk, to detail new meetings only. */
const GRANOLA_KNOWN_CAP = 1_000;
// A source clock and ours can differ, so a recheck also takes items from a
// short time before the last check.
const CHANGE_MARGIN_MS = 10 * 60_000;

interface HistoryCursor {
  offset?: number;
  complete?: boolean;
  checkedAt?: number;
  known?: string[];
  /** REST walks: the Slack query or Atlassian site, and the page in it. */
  query?: number;
  page?: number;
  site?: number;
  pageToken?: string;
}

const defaults = {
  convexMutation,
  callMcpTool,
  connectMcp,
  getConnectionToken,
  listUserConnections,
  loadSlackHistoryPage,
  loadSlackChangedMessages,
  loadAtlassianHistoryPage,
  loadAtlassianChangedIssues,
};

/**
 * One pass of the history walk for a provider sign-in that reads a REST API
 * (Slack, Atlassian). Both walks keep to items that involve the user, so they
 * end; after the end, a pass takes only items that changed.
 */
async function readRestHistory(input: {
  deps: typeof defaults;
  transport: 'slack-rest' | 'atlassian-rest';
  serverUrl: string;
  token: string;
  saved: HistoryCursor;
  now: number;
}): Promise<{ items: NormalizedMcpItem[]; cursor: HistoryCursor; status: string }> {
  const { deps, transport, serverUrl, token, saved, now } = input;
  const slack = transport === 'slack-rest';
  if (saved.complete) {
    const since = (saved.checkedAt || 0) - CHANGE_MARGIN_MS;
    const changed = slack
      ? await deps.loadSlackChangedMessages(serverUrl, token, since, now)
      : await deps.loadAtlassianChangedIssues(serverUrl, token, since, now);
    // A read that the page limit ended early saves where it stopped, so the
    // next recheck reads the pages that remain. A stop at or before the saved
    // check would move the cursor back, so it fails and keeps the cursor.
    if (changed.resumeAt !== undefined && changed.resumeAt <= (saved.checkedAt || 0)) {
      throw new Error('The change recheck reached its page limit before the last check.');
    }
    return {
      items: changed.items,
      cursor: { complete: true, checkedAt: changed.resumeAt ?? now },
      status: 'provider_limited',
    };
  }
  if (slack) {
    const page = await deps.loadSlackHistoryPage(
      serverUrl,
      token,
      { query: saved.query ?? 0, page: saved.page ?? 1 },
      now,
    );
    return page.next
      ? { items: page.items, cursor: { query: page.next.query, page: page.next.page }, status: 'indexing' }
      : { items: page.items, cursor: { complete: true, checkedAt: now }, status: 'provider_limited' };
  }
  const page = await deps.loadAtlassianHistoryPage(serverUrl, token, {
    site: saved.site ?? 0,
    token: saved.pageToken,
  });
  return page.next
    ? {
        items: page.items,
        cursor: { site: page.next.site, ...(page.next.token ? { pageToken: page.next.token } : {}) },
        status: 'indexing',
      }
    : { items: page.items, cursor: { complete: true, checkedAt: now }, status: 'provider_limited' };
}
export async function syncMcpContent(userId: string, deps = defaults) {
  for (const connection of await deps.listUserConnections(userId)) {
    // Only a working sign-in can page the source (AI-7). A reconnect-needed
    // row keeps its indexed items; the main sync heals it back to connected.
    if (
      connection.status !== 'connected' ||
      (!connection.includeInSearch && !connection.includeInBrief) ||
      !['slack', 'jira', 'granola'].includes(connection.server)
    )
      continue;
    const connectionId = `__history:${connection.connectionId}`;
    const claim = await deps.convexMutation<any>(api.content.claimSync, { userId, connectionId });
    if (!claim) continue;
    const saved: HistoryCursor = claim.cursor && typeof claim.cursor === 'object' ? claim.cursor : {};
    const now = Date.now();
    if (saved.complete && now - (saved.checkedAt || 0) < HISTORY_RECHECK_MS) {
      // The walk is complete and the last check is recent: no source call.
      await deps.convexMutation(api.content.finishSync, {
        userId,
        connectionId,
        lease: claim.lease,
        indexed: 0,
        skipped: 0,
        status: 'provider_limited',
      });
      continue;
    }
    let handle: Awaited<ReturnType<typeof connectMcp>> | undefined;
    try {
      const credentials = await deps.getConnectionToken(userId, connection.connectionId);
      if (!credentials) throw new Error('Source credentials unavailable.');
      const definition = getServerDef(connection.server)!;
      const transport = connectionTransport(definition, connection.authKind);
      let items: NormalizedMcpItem[] = [];
      let cursor: HistoryCursor;
      let status = 'provider_limited';
      if (transport === 'slack-rest' || transport === 'atlassian-rest') {
        ({ items, cursor, status } = await readRestHistory({
          deps,
          transport,
          serverUrl: credentials.row?.serverUrl || connection.serverUrl,
          token: credentials.token,
          saved,
          now,
        }));
      } else {
        // The server filter above lets only Slack, Jira, and Granola in, so
        // every other connection here is an MCP connection.
        handle = await deps.connectMcp(connection.serverUrl, credentials.token, definition.authMode);
        const tool = definition.syncQueries[0].tool;
        if (!handle.toolNames.has(tool)) throw new Error('Source listing tool unavailable.');
        const properties = (handle.toolSchemas?.get(tool) as any)?.properties || {};
        if (connection.server === 'granola') {
          const listed = normalizeItems(
            { tool, args: {}, kind: 'meeting' },
            await deps.callMcpTool(handle, tool, {}),
          );
          const known = new Set(saved.known || []);
          const start = saved.complete ? 0 : Number(saved.offset || 0) % Math.max(1, listed.length);
          // After the walk, only meetings the pass has not seen get details.
          const selected = saved.complete
            ? listed.filter((item) => !known.has(item.externalId)).slice(0, 20)
            : listed.slice(start, start + 20);
          items = selected;
          const batches = handle.toolNames.has('get_meetings')
            ? granolaMeetingDetailBatches(
                handle.toolSchemas?.get('get_meetings'),
                selected.map((item) => item.externalId),
              )
            : [];
          if (batches.length) {
            const detailed: NormalizedMcpItem[] = [];
            for (const detail of batches)
              detailed.push(
                ...normalizeItems(
                  { tool: 'get_meetings', args: detail, kind: 'meeting' },
                  await deps.callMcpTool(handle, 'get_meetings', detail),
                ),
              );
            items = mergeGranolaMeetingDetails(selected, detailed);
          }
          const next = start + selected.length;
          if (!saved.complete && next < listed.length) {
            cursor = { offset: next };
            status = 'indexing';
          } else {
            for (const item of saved.complete ? selected : listed) known.add(item.externalId);
            cursor = { complete: true, checkedAt: now, known: [...known].slice(-GRANOLA_KNOWN_CAP) };
          }
        } else {
          const slack = connection.server === 'slack';
          const pageKey = slack ? 'page' : 'startAt';
          const canPage = Boolean(properties[pageKey]);
          const base: Record<string, unknown> = slack
            ? { query: 'after:1970-01-01', count: 100 }
            : { jql: 'updated >= "1970-01-01" ORDER BY updated DESC', maxResults: 100 };
          if (slack && properties.sort) base.sort = 'timestamp';
          if (slack && properties.sort_dir) base.sort_dir = 'desc';
          const first = slack ? 1 : 0;
          const read = async (offset: number) => {
            const args = { ...base, ...(canPage ? { [pageKey]: offset } : {}) };
            return normalizeItems(
              { tool, args, kind: slack ? 'message' : 'ticket' },
              await deps.callMcpTool(handle!, tool, args),
            );
          };
          if (saved.complete) {
            // The first page holds the newest items. Keep only the items that
            // changed since the last check (or that carry no time).
            const since = (saved.checkedAt || 0) - CHANGE_MARGIN_MS;
            items = (await read(first)).filter(
              (item) => item.updatedAtSource === undefined || item.updatedAtSource > since,
            );
            cursor = { offset: first, complete: true, checkedAt: now };
          } else {
            const current = Number(saved.offset || first);
            // While the walk runs, the first page is read again for new items.
            if (canPage && current > first) items.push(...(await read(first)));
            const page = await read(current);
            items.push(...page);
            if (canPage && page.length) {
              cursor = { offset: current + (slack ? 1 : page.length) };
              status = 'indexing';
            } else cursor = { offset: first, complete: true, checkedAt: now };
          }
        }
      }
      items = [...new Map(items.map((item) => [item.externalId, item])).values()];
      for (let i = 0; i < items.length; i += 50)
        await deps.convexMutation(api.mcp.upsertItems, {
          userId,
          connectionId: connection.connectionId,
          server: connection.server,
          items: items.slice(i, i + 50),
        });
      await deps.convexMutation(api.content.finishSync, {
        userId,
        connectionId,
        lease: claim.lease,
        cursor,
        indexed: items.length,
        skipped: 0,
        status,
      });
    } catch {
      await deps.convexMutation(api.content.finishSync, {
        userId,
        connectionId,
        lease: claim.lease,
        indexed: 0,
        skipped: 0,
        status: 'error',
        error: 'Extended source sync could not finish; existing indexed content is unchanged.',
      });
    } finally {
      await handle?.close();
    }
  }
}
