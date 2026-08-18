import { describe, expect, test } from 'bun:test';
import './tools/harness';
import { dedupeSimilarTasks } from '../lib/mail/daily-report';
import type { DailyReportTaskItem } from '../lib/shared/types';

function task(cardId: string, title: string, overrides: Partial<DailyReportTaskItem> = {}) {
  return {
    cardId,
    boardId: 'board_1',
    columnId: 'column_1',
    title,
    scope: 'week',
    ...overrides,
  } as DailyReportTaskItem;
}

describe('dedupeSimilarTasks', () => {
  test('near-identical open tasks collapse to the first copy in sort order', () => {
    const deduped = dedupeSimilarTasks([
      task('massage-1', 'Clear the obsolete August 16 massage hold and get Tree’s September work schedule'),
      task('massage-2', 'Clear the obsolete Tree massage hold and get Tree’s September work schedule'),
      task('license-1', 'Complete NY DMV pre-screening and reserve an Enhanced License visit'),
      task('license-2', 'Complete NY DMV pre-screening and book an enhanced-license appointment'),
      task('mom', 'Find Mom’s request and send the needed response'),
    ]);
    expect(deduped.map((item) => item.cardId)).toEqual(['massage-1', 'license-1', 'mom']);
  });

  test('distinct outcomes with shared words survive', () => {
    const deduped = dedupeSimilarTasks([
      task('book-massage', 'Book Tree’s massage at Amazing Mind Body Soul Center'),
      task('book-dinner', 'Book dinner reservations for Friday with the team'),
    ]);
    expect(deduped.map((item) => item.cardId)).toEqual(['book-massage', 'book-dinner']);
  });

  test('completed tasks never absorb an open duplicate', () => {
    const deduped = dedupeSimilarTasks([
      task('done', 'Confirm Yates County initial pistol permit requirements', { completedAt: 5 }),
      task('open', 'Confirm Yates County initial pistol permit requirements'),
    ]);
    expect(deduped.map((item) => item.cardId)).toEqual(['done', 'open']);
  });

  test('titles with no meaningful terms pass through untouched', () => {
    const deduped = dedupeSimilarTasks([task('a', '!!'), task('b', '??')]);
    expect(deduped.map((item) => item.cardId)).toEqual(['a', 'b']);
  });
});
