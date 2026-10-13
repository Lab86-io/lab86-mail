import { mcpItemName } from '../mcp/connection-display';
import { truncateText } from '../shared/text';
import type { DailyReportMcpItem } from '../shared/types';

// Relevance ranking for connected-tool items in the Daily Brief (brief round
// 2026-09-22). Pure and deterministic: assignment to the user, an open or
// review state, and recency decide the order. The brief shows the top few.

export const CONNECTED_BRIEF_LIMIT = 4;
const RECENT_WINDOW_MS = 48 * 3600_000;

const OPEN_STATES = new Set([
  'open',
  'opened',
  'in_progress',
  'in progress',
  'review_requested',
  'changes_requested',
  'todo',
  'to do',
  'selected for development',
  'ready',
  'blocked',
]);
const CLOSED_STATES = new Set(['closed', 'merged', 'done', 'resolved', 'cancelled', 'canceled', 'archived']);

/**
 * The category that a Jira ticket row keeps with its status: "done", or one
 * of the open categories ("new", "indeterminate"). Other rows have none.
 */
export function connectedStateCategory(row: {
  server?: unknown;
  kind?: unknown;
  raw?: unknown;
}): DailyReportMcpItem['stateCategory'] {
  if (row.server !== 'jira' || row.kind !== 'ticket') return undefined;
  const category = (row.raw as { statusCategory?: unknown } | null | undefined)?.statusCategory;
  if (category === 'done') return 'done';
  return category === 'new' || category === 'indeterminate' ? 'open' : undefined;
}

/** A row of the connected-tool index as an item of the Daily Brief. */
export function connectedBriefItem(row: any): DailyReportMcpItem {
  return {
    server: row.server,
    externalId: row.externalId ? String(row.externalId) : undefined,
    kind: row.kind,
    title: row.title,
    state: row.state ?? null,
    author: row.author ?? null,
    url: row.url ?? null,
    updatedAt: row.updatedAtSource ?? null,
    assignedToUser: Boolean(row.assignedToUser),
    stateCategory: connectedStateCategory(row),
    repository: row.repository ?? null,
    summary: row.summary ? truncateText(String(row.summary), 400) : null,
  };
}

export function connectedItemScore(item: DailyReportMcpItem, now: number): number {
  let score = 0;
  if (item.assignedToUser) score += 3;
  const state = String(item.state || '').toLowerCase();
  // The category of the source decides before the state name does.
  const open = item.stateCategory ? item.stateCategory === 'open' : OPEN_STATES.has(state);
  const closed = item.stateCategory ? item.stateCategory === 'done' : CLOSED_STATES.has(state);
  if (open) score += 1;
  if (closed) score -= 2;
  if (typeof item.updatedAt === 'number' && now - item.updatedAt <= RECENT_WINDOW_MS) score += 2;
  if (item.kind === 'pull_request' && (state === 'review_requested' || state === 'changes_requested')) {
    score += 2;
  }
  if (item.kind === 'meeting') score += 1;
  return score;
}

export function rankConnectedItems(
  items: DailyReportMcpItem[],
  now: number,
  limit = CONNECTED_BRIEF_LIMIT,
): DailyReportMcpItem[] {
  const seen = new Set<string>();
  return [...items]
    .filter((item) => {
      const key = `${item.server}:${item.externalId || item.url || item.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return Boolean(item.title);
    })
    .map((item) => ({ item, score: connectedItemScore(item, now) }))
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.item.updatedAt || 0) - Number(a.item.updatedAt || 0) ||
        a.item.title.localeCompare(b.item.title),
    )
    .slice(0, limit)
    .map((entry) => entry.item);
}

// One short line under a connected item: "GitHub pull request, review requested".
export function connectedItemReason(item: DailyReportMcpItem): string {
  // A Confluence page reads "Confluence page", not "Jira page".
  const parts = [mcpItemName(item)];
  const state = String(item.state || '')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  if (state) parts.push(state);
  if (item.assignedToUser) parts.push('assigned to you');
  else if (item.repository) parts.push(item.repository);
  return parts.join(', ');
}
