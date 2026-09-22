'use client';
import { useEffect } from 'react';

/** A filtered empty page has no visible scroll sentinel; keep its cursor moving. */
export function useEmptyPageContinuation(
  count: number,
  hasNextPage: boolean,
  fetching: boolean,
  failed: boolean,
  fetchNextPage: () => Promise<unknown>,
) {
  useEffect(() => {
    if (count === 0 && hasNextPage && !fetching && !failed) void fetchNextPage().catch(() => undefined);
  }, [count, hasNextPage, fetching, failed, fetchNextPage]);
}
