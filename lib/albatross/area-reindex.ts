export const AREA_REINDEX_PAGE_SIZE = 100;
export const AREA_REINDEX_MAX_PAGES = 100;
export const AREA_REINDEX_MAX_SCANNED = AREA_REINDEX_PAGE_SIZE * AREA_REINDEX_MAX_PAGES;

export function remainingAreaReindexPageSize(scanned?: number | null): number {
  const used = Math.max(0, Math.floor(Number(scanned ?? 0)));
  return Math.max(0, Math.min(AREA_REINDEX_PAGE_SIZE, AREA_REINDEX_MAX_SCANNED - used));
}

export function isCurrentAreaReindexInvocation(input: {
  hasTrackedRun: boolean;
  status?: 'queued' | 'running' | 'done' | 'error' | null;
  pages?: number | null;
  expectedCursor?: string | null;
  cursor?: string | null;
}): boolean {
  if (!input.hasTrackedRun || (input.status !== 'queued' && input.status !== 'running')) return false;
  if (input.cursor) return input.cursor === input.expectedCursor;
  return !input.expectedCursor && Math.max(0, Math.floor(Number(input.pages ?? 0))) === 0;
}

export function canonicalLatestMessageId(
  latestCorpusMessageId?: string | null,
  threadLatestMessageId?: string | null,
): string | undefined {
  return latestCorpusMessageId || threadLatestMessageId || undefined;
}

export function areaReindexMatchCounterDelta(refreshedExistingAutomatic: boolean) {
  return { inserted: refreshedExistingAutomatic ? 0 : 1, matched: 1 };
}

export function shouldCoalesceAreaReindex(input: {
  hasCursor: boolean;
  currentId: string;
  currentCreatedAt: number;
  latestId?: string | null;
  latestCreatedAt?: number | null;
}): boolean {
  return Boolean(
    !input.hasCursor &&
      input.latestId &&
      input.latestId !== input.currentId &&
      Number(input.latestCreatedAt) >= input.currentCreatedAt,
  );
}

export function nextAreaReindexPage(previousPages?: number | null): {
  page: number;
  allowed: boolean;
} {
  const page = Math.max(0, Math.floor(Number(previousPages ?? 0))) + 1;
  return { page, allowed: page <= AREA_REINDEX_MAX_PAGES };
}

export function areaReindexCursorAdvanced(input: {
  isDone: boolean;
  currentCursor?: string | null;
  nextCursor?: string | null;
}): boolean {
  return input.isDone || Boolean(input.nextCursor && input.nextCursor !== input.currentCursor);
}
