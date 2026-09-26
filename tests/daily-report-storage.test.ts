import { expect, test } from 'bun:test';
import {
  DAILY_REPORT_STORED_BYTE_LIMIT,
  dailyReportForStorage,
  migrateDailyReport,
  saveDailyReport,
} from '../lib/store/daily-reports';
import { editorialFixture } from './fixtures/editorial';
import { NOW } from './fixtures/jev';

function v2Edition() {
  const { edition } = editorialFixture();
  const read = migrateDailyReport(edition, NOW);
  return {
    ...read,
    artifactSource: 'document-v2' as const,
    artifactStatus: 'ready' as const,
    sections: {
      ...read.sections,
      overflow: [
        {
          account: 'account-a',
          threadId: 'extra',
          subject: 'Extra',
          people: ['a@example.com', 'b@example.com'],
          whyItMatters: 'A later reply.',
          line: 'Reply when you can.',
          openLoops: ['x'.repeat(500)],
          nextAction: 'Open it',
          surfacedBecause: ['jev'],
          unread: true,
          score: 4,
        },
      ],
    },
  };
}

test('a document-v2 edition is stored without legacy html, composition, and handoffs', async () => {
  const edition = v2Edition();
  expect(edition.html).toBeTruthy();
  expect(edition.composition).toBeTruthy();
  const stored = dailyReportForStorage(edition);
  expect(stored.html).toBeUndefined();
  expect(stored.composition).toBeUndefined();
  expect(stored.handoffs).toBeUndefined();
  expect(stored.document).toEqual(edition.document);
  expect(stored.sections.overflow?.[0]).toEqual({
    account: 'account-a',
    threadId: 'extra',
    subject: 'Extra',
    people: [],
    whyItMatters: 'A later reply.',
    line: 'Reply when you can.',
    unread: true,
    score: 4,
  });
  // Readers rebuild the legacy fields from the stored sections.
  const read = migrateDailyReport(stored, NOW);
  expect(read.html).toBeTruthy();
  expect(read.composition).toBeTruthy();
  expect(read.handoffs?.length).toBeGreaterThan(0);

  const persisted: any[] = [];
  await saveDailyReport(edition, {
    persist: async (_kind: string, _key: string, doc: unknown) => {
      persisted.push(doc);
      return doc;
    },
    configured: () => false,
    owner: () => 'reader',
    mark: async () => undefined,
  } as any);
  expect(persisted[0].html).toBeUndefined();

  // Other editions keep their legacy artifact.
  const legacy = { ...edition, artifactSource: 'deterministic' as const };
  expect(dailyReportForStorage(legacy)).toBe(legacy);
});

test('an oversized edition degrades below the limit instead of failing the save', () => {
  const edition = v2Edition();
  const big = 'y'.repeat(4000);
  const many = (prefix: string) =>
    Array.from({ length: 260 }, (_, i) => ({
      ...edition.sections.overflow![0],
      threadId: `${prefix}-${i}`,
      whyItMatters: big,
    }));
  const overflowOnly = { ...edition, sections: { ...edition.sections, overflow: many('o') } };
  const trimmed = dailyReportForStorage(overflowOnly);
  expect(JSON.stringify(trimmed).length).toBeLessThanOrEqual(DAILY_REPORT_STORED_BYTE_LIMIT);
  expect(trimmed.sections.overflow).toEqual([]);
  expect(trimmed.document).toBeDefined();
  expect(trimmed.artifactErrors?.at(-1)?.message).toContain('too large');

  const huge = {
    ...overflowOnly,
    sections: { ...overflowOnly.sections, replyOwed: many('r'), timeSensitive: many('t') },
    document: { ...edition.document!, summary: 'z'.repeat(DAILY_REPORT_STORED_BYTE_LIMIT) },
  };
  const degraded = dailyReportForStorage(huge);
  expect(JSON.stringify(degraded).length).toBeLessThanOrEqual(DAILY_REPORT_STORED_BYTE_LIMIT);
  expect(degraded.document).toBeUndefined();
  expect(degraded.sections.replyOwed).toEqual([]);
  expect(degraded.artifactSource).toBe('deterministic');
  // The degraded edition still reads as a complete letter.
  expect(migrateDailyReport(degraded, NOW).html).toBeTruthy();
});
