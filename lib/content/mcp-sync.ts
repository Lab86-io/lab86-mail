import { api, convexMutation } from '../hosted/convex';
import { callMcpTool, connectMcp } from '../mcp/client';
import { getConnectionToken, listUserConnections } from '../mcp/connections';
import { granolaMeetingDetailArgs, mergeGranolaMeetingDetails } from '../mcp/granola';
import { getServerDef, normalizeItems } from '../mcp/servers';

/** Expand beyond the Brief's small recent-item feed, but only with pagination
 * parameters the connected server actually advertises. Never report full
 * coverage when the server only exposes a limited search window. */
const defaults = { convexMutation, callMcpTool, connectMcp, getConnectionToken, listUserConnections };
export async function syncMcpContent(userId: string, deps = defaults) {
  for (const connection of await deps.listUserConnections(userId)) {
    if (
      connection.status === 'disconnected' ||
      (!connection.includeInSearch && !connection.includeInBrief) ||
      !['slack', 'jira', 'granola'].includes(connection.server)
    )
      continue;
    const connectionId = `__history:${connection.connectionId}`;
    const claim = await deps.convexMutation<any>((api as any).content.claimSync, { userId, connectionId });
    if (!claim) continue;
    let handle: Awaited<ReturnType<typeof connectMcp>> | undefined;
    try {
      const credentials = await deps.getConnectionToken(userId, connection.connectionId);
      if (!credentials) throw new Error('Source credentials unavailable.');
      const definition = getServerDef(connection.server)!;
      handle = await deps.connectMcp(connection.serverUrl, credentials.token, definition.authMode);
      const tool = definition.syncQueries[0].tool;
      if (!handle.toolNames.has(tool)) throw new Error('Source listing tool unavailable.');
      const properties = (handle.toolSchemas?.get(tool) as any)?.properties || {};
      let items: ReturnType<typeof normalizeItems> = [];
      let cursor: any = null;
      let status = 'provider_limited';
      if (connection.server === 'granola') {
        const listed = normalizeItems(
          { tool, args: {}, kind: 'meeting' },
          await deps.callMcpTool(handle, tool, {}),
        );
        const start = Number(claim.cursor?.offset || 0) % Math.max(1, listed.length);
        const selected = listed.slice(start, start + 20);
        const detail = granolaMeetingDetailArgs(
          handle.toolSchemas?.get('get_meetings'),
          selected.map((item) => item.externalId),
        );
        if (detail && handle.toolNames.has('get_meetings')) {
          items = mergeGranolaMeetingDetails(
            selected,
            normalizeItems(
              { tool: 'get_meetings', args: detail, kind: 'meeting' },
              await deps.callMcpTool(handle, 'get_meetings', detail),
            ),
          );
          cursor = { offset: start + selected.length < listed.length ? start + selected.length : 0 };
          status = cursor.offset ? 'indexing' : 'provider_limited';
        } else items = selected;
      } else {
        const slack = connection.server === 'slack';
        const pageKey = slack ? 'page' : 'startAt';
        const canPage = Boolean(properties[pageKey]);
        const base: Record<string, unknown> = slack
          ? { query: 'after:1970-01-01', count: 100 }
          : { jql: 'updated >= "1970-01-01" ORDER BY updated DESC', maxResults: 100 };
        if (slack && properties.sort) base.sort = 'timestamp';
        if (slack && properties.sort_dir) base.sort_dir = 'desc';
        const current = Number(claim.cursor?.offset || (slack ? 1 : 0));
        const offsets = canPage && current > (slack ? 1 : 0) ? [slack ? 1 : 0, current] : [current];
        for (const offset of offsets) {
          const args = { ...base, ...(canPage ? { [pageKey]: offset } : {}) };
          const page = normalizeItems(
            { tool, args, kind: slack ? 'message' : 'ticket' },
            await deps.callMcpTool(handle, tool, args),
          );
          items.push(...page);
          if (offset === current && canPage) {
            cursor = { offset: page.length ? current + (slack ? 1 : page.length) : slack ? 1 : 0 };
            status = page.length ? 'indexing' : 'provider_limited';
          }
        }
      }
      items = [...new Map(items.map((item) => [item.externalId, item])).values()];
      for (let i = 0; i < items.length; i += 50)
        await deps.convexMutation((api as any).mcp.upsertItems, {
          userId,
          connectionId: connection.connectionId,
          server: connection.server,
          items: items.slice(i, i + 50),
        });
      await deps.convexMutation((api as any).content.finishSync, {
        userId,
        connectionId,
        lease: claim.lease,
        cursor,
        indexed: items.length,
        skipped: 0,
        status,
      });
    } catch {
      await deps.convexMutation((api as any).content.finishSync, {
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
