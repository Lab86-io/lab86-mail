import { describe, expect, test } from 'bun:test';
import { LIST_PREFETCH_MARGIN_PX, shouldRequestNextPage } from '../lib/mail/list-pagination';

const base = { inFlight: false, hasMore: true, distanceToEnd: 0 };

describe('shouldRequestNextPage', () => {
  test('fetches when the sentinel is visible and nothing is in flight', () => {
    expect(shouldRequestNextPage(base)).toBe(true);
    expect(shouldRequestNextPage({ ...base, distanceToEnd: -200 })).toBe(true);
  });

  test('prefetches while the sentinel is still below the viewport', () => {
    expect(shouldRequestNextPage({ ...base, distanceToEnd: LIST_PREFETCH_MARGIN_PX })).toBe(true);
    expect(shouldRequestNextPage({ ...base, distanceToEnd: LIST_PREFETCH_MARGIN_PX + 1 })).toBe(false);
  });

  test('never double-fetches while a request is in flight', () => {
    expect(shouldRequestNextPage({ ...base, inFlight: true })).toBe(false);
  });

  test('stops at the end of the list', () => {
    expect(shouldRequestNextPage({ ...base, hasMore: false })).toBe(false);
  });

  test('does not auto-chain after an error — the user retries explicitly', () => {
    expect(shouldRequestNextPage({ ...base, lastError: true })).toBe(false);
    expect(shouldRequestNextPage({ ...base, lastError: false })).toBe(true);
  });

  test('treats unknown distance as too far', () => {
    expect(shouldRequestNextPage({ ...base, distanceToEnd: Number.POSITIVE_INFINITY })).toBe(false);
    expect(shouldRequestNextPage({ ...base, distanceToEnd: Number.NaN })).toBe(false);
  });

  test('honors a custom prefetch window', () => {
    expect(shouldRequestNextPage({ ...base, distanceToEnd: 500, prefetchDistance: 400 })).toBe(false);
    expect(shouldRequestNextPage({ ...base, distanceToEnd: 300, prefetchDistance: 400 })).toBe(true);
  });
});
