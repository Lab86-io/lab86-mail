import { describe, expect, test } from 'bun:test';
import {
  AREA_REINDEX_MAX_PAGES,
  areaReindexCursorAdvanced,
  areaReindexMatchCounterDelta,
  canonicalLatestMessageId,
  nextAreaReindexPage,
  shouldCoalesceAreaReindex,
} from '../lib/albatross/area-reindex';

describe('Area reindex scheduling safety', () => {
  test('coalesces an older queued run into a newer request, but never a continuation page', () => {
    const input = {
      hasCursor: false,
      currentId: 'old',
      currentCreatedAt: 100,
      latestId: 'new',
      latestCreatedAt: 200,
    };
    expect(shouldCoalesceAreaReindex(input)).toBe(true);
    expect(shouldCoalesceAreaReindex({ ...input, hasCursor: true })).toBe(false);
    expect(shouldCoalesceAreaReindex({ ...input, latestCreatedAt: 50 })).toBe(false);
    expect(shouldCoalesceAreaReindex({ ...input, latestCreatedAt: 100 })).toBe(true);
  });

  test('has a hard 10,000-thread page budget', () => {
    expect(nextAreaReindexPage(AREA_REINDEX_MAX_PAGES - 1)).toEqual({
      page: AREA_REINDEX_MAX_PAGES,
      allowed: true,
    });
    expect(nextAreaReindexPage(AREA_REINDEX_MAX_PAGES).allowed).toBe(false);
  });

  test('rejects a repeating continuation cursor', () => {
    expect(areaReindexCursorAdvanced({ isDone: false, currentCursor: 'same', nextCursor: 'same' })).toBe(
      false,
    );
    expect(areaReindexCursorAdvanced({ isDone: false, currentCursor: 'a', nextCursor: 'b' })).toBe(true);
    expect(areaReindexCursorAdvanced({ isDone: true, currentCursor: 'same', nextCursor: 'same' })).toBe(true);
  });

  test('resolves legacy thread message ids from the canonical corpus message', () => {
    expect(canonicalLatestMessageId('message_new', undefined)).toBe('message_new');
    expect(canonicalLatestMessageId(undefined, 'message_legacy')).toBe('message_legacy');
  });

  test('counts an existing-link refresh as matched but not inserted', () => {
    expect(areaReindexMatchCounterDelta(true)).toEqual({ inserted: 0, matched: 1 });
    expect(areaReindexMatchCounterDelta(false)).toEqual({ inserted: 1, matched: 1 });
  });
});
