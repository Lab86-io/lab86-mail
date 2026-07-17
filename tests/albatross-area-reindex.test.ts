import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  AREA_REINDEX_MAX_PAGES,
  AREA_REINDEX_MAX_SCANNED,
  AREA_REINDEX_PAGE_SIZE,
  areaReindexCursorAdvanced,
  areaReindexMatchCounterDelta,
  canonicalLatestMessageId,
  isCurrentAreaReindexInvocation,
  nextAreaReindexPage,
  remainingAreaReindexPageSize,
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
    expect(AREA_REINDEX_PAGE_SIZE).toBe(100);
    expect(AREA_REINDEX_MAX_SCANNED).toBe(10_000);
    expect(remainingAreaReindexPageSize(0)).toBe(100);
    expect(remainingAreaReindexPageSize(9_950)).toBe(50);
    expect(remainingAreaReindexPageSize(9_999)).toBe(1);
    expect(remainingAreaReindexPageSize(10_000)).toBe(0);
    expect(nextAreaReindexPage(AREA_REINDEX_MAX_PAGES - 1)).toEqual({
      page: AREA_REINDEX_MAX_PAGES,
      allowed: true,
    });
    expect(nextAreaReindexPage(AREA_REINDEX_MAX_PAGES).allowed).toBe(false);
  });

  test('allows only the invocation that owns the run cursor', () => {
    expect(isCurrentAreaReindexInvocation({ hasTrackedRun: false })).toBe(false);
    expect(isCurrentAreaReindexInvocation({ hasTrackedRun: true })).toBe(false);
    expect(isCurrentAreaReindexInvocation({ hasTrackedRun: true, status: 'queued', pages: 0 })).toBe(true);
    expect(isCurrentAreaReindexInvocation({ hasTrackedRun: true, status: 'running', pages: 1 })).toBe(false);
    expect(
      isCurrentAreaReindexInvocation({
        hasTrackedRun: true,
        status: 'running',
        pages: 1,
        expectedCursor: 'next',
        cursor: 'stale',
      }),
    ).toBe(false);
    expect(
      isCurrentAreaReindexInvocation({
        hasTrackedRun: true,
        status: 'running',
        pages: 1,
        expectedCursor: 'next',
        cursor: 'next',
      }),
    ).toBe(true);
    expect(isCurrentAreaReindexInvocation({ hasTrackedRun: true, status: 'done', pages: 1 })).toBe(false);
  });

  test('walks recent threads newest-first through the selective date index', () => {
    const source = readFileSync(path.join(process.cwd(), 'convex/albatross.ts'), 'utf8');
    const start = source.indexOf('export const reindexUserAreaArtifacts');
    const end = source.indexOf('type SeedFixture', start);
    const reindex = source.slice(start, end);
    const scanStart = reindex.indexOf(".query('mailCorpusThreads')");
    const scanEnd = reindex.indexOf('for (const row of page.page)', scanStart);
    const threadScan = reindex.slice(scanStart, scanEnd);

    expect(threadScan).toContain(".withIndex('by_user_lastDate'");
    expect(threadScan).toContain(".eq('userId', userId)");
    expect(threadScan).toContain(".gte('lastDate', cutoff)");
    expect(threadScan).toContain(".order('desc')");
    expect(threadScan).toContain('.paginate({ cursor: args.cursor ?? null, numItems: pageSize })');
    expect(threadScan).not.toContain(".withIndex('by_user'");
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
