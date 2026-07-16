export const AREA_REINDEX_MAX_PAGES = 100;

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
