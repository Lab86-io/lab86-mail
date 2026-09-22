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

export function connectedItemScore(item: DailyReportMcpItem, now: number): number {
  let score = 0;
  if (item.assignedToUser) score += 3;
  const state = String(item.state || '').toLowerCase();
  if (OPEN_STATES.has(state)) score += 1;
  if (CLOSED_STATES.has(state)) score -= 2;
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

const SERVER_LABELS: Record<DailyReportMcpItem['server'], string> = {
  github: 'GitHub',
  bitbucket: 'Bitbucket',
  jira: 'Jira',
  slack: 'Slack',
  granola: 'Granola',
};

const KIND_LABELS: Record<string, string> = {
  pull_request: 'pull request',
  issue: 'issue',
  commit: 'commit',
  project: 'project',
  project_item: 'project item',
  ticket: 'ticket',
  message: 'message',
  meeting: 'meeting',
};

// One short line under a connected item: "GitHub pull request, review requested".
export function connectedItemReason(item: DailyReportMcpItem): string {
  const parts = [`${SERVER_LABELS[item.server] || item.server} ${KIND_LABELS[item.kind] || item.kind}`];
  const state = String(item.state || '')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  if (state) parts.push(state);
  if (item.assignedToUser) parts.push('assigned to you');
  else if (item.repository) parts.push(item.repository);
  return parts.join(', ');
}
