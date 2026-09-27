import { safeSlice } from '../../shared/text';

/** The same order must survive database, thread grouping, account merge and UI. */
export function mailListUsesRelevance(
  items: readonly { searchRank?: number; searchOrder?: 'recent' | 'relevance' }[],
  smartCategory?: string | null,
) {
  return (
    !smartCategory && items.some((item) => item.searchRank !== undefined && item.searchOrder !== 'recent')
  );
}
export function compareMailRelevance(
  a: {
    searchRelevance?: number;
    searchRank?: number;
    lastDate?: number;
    searchOrder?: 'recent' | 'relevance';
  },
  b: {
    searchRelevance?: number;
    searchRank?: number;
    lastDate?: number;
    searchOrder?: 'recent' | 'relevance';
  },
) {
  if (a.searchOrder === 'recent' && b.searchOrder === 'recent') return (b.lastDate || 0) - (a.lastDate || 0);
  const scoreA = a.searchRelevance;
  const scoreB = b.searchRelevance;
  if (scoreA !== undefined || scoreB !== undefined) {
    const delta = (scoreB ?? 0.5) - (scoreA ?? 0.5);
    if (delta) return delta;
  }
  return (
    (a.searchRank ?? Number.MAX_SAFE_INTEGER) - (b.searchRank ?? Number.MAX_SAFE_INTEGER) ||
    (b.lastDate || 0) - (a.lastDate || 0)
  );
}
export function matchingMailExcerpt(body: string, query: string) {
  const terms = query.toLowerCase().match(/[\p{L}\p{N}@._-]{3,}/gu) || [];
  const lower = body.toLowerCase();
  const positions = terms
    .filter((term) => !['the', 'and', 'from', 'with', 'that', 'this', 'for'].includes(term))
    .map((term) => lower.indexOf(term))
    .filter((index) => index >= 0);
  const start = positions.length ? Math.max(0, Math.min(...positions) - 120) : 0;
  return safeSlice(body, start, start + 1600);
}
