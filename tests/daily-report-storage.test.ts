import { expect, test } from 'bun:test';
import { DEFAULT_JEV_PREFERENCES, type JevAssessment } from '../lib/jev/contract';
import { briefJevDigest, projectBriefMail } from '../lib/jev/report';
import type { DailyReport, DailyReportItem } from '../lib/shared/types';
import {
  DAILY_REPORT_STORED_BYTE_LIMIT,
  dailyReportForStorage,
  migrateDailyReport,
  saveDailyReport,
} from '../lib/store/daily-reports';
import { editorialFixture } from './fixtures/editorial';
import { assessment, NOW, reportItem, thread } from './fixtures/jev';

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

/** A full assessment with the largest evidence the schema allows. */
function heavyAssessment(revision: string, patch: Partial<JevAssessment> = {}): JevAssessment {
  const evidence = (id: string) => ({ messageId: id, text: 'e'.repeat(2400) });
  return assessment({
    sourceRevision: revision,
    obligations: [
      { kind: 'reply', evidence: evidence('m1'), probability: 0.98 },
      { kind: 'action', evidence: evidence('m2'), probability: 0.9 },
      { kind: 'waiting', evidence: evidence('m3'), probability: 0.6 },
    ],
    changeEvidence: evidence('m4'),
    ...patch,
  });
}

function withOverflow(items: DailyReportItem[]): DailyReport {
  const edition = v2Edition();
  return { ...edition, sections: { ...edition.sections, overflow: items } };
}

test('a stored overflow item keeps only the Jev fields the live refresh reads', () => {
  const full = heavyAssessment('rev-1', { meaningfulChange: true });
  const stored = dailyReportForStorage(withOverflow([reportItem({ threadId: 'o1', jev: full })]));
  expect(stored.sections.overflow?.[0].jev).toEqual({
    sourceRevision: 'rev-1',
    meaningfulChange: true,
    obligations: [{ kind: 'reply' }, { kind: 'action' }, { kind: 'waiting' }],
  });
  expect(briefJevDigest(briefJevDigest(full))).toEqual(briefJevDigest(full));
  // Selected items keep the full assessment; only overflow is slimmed.
  expect(stored.sections.answer?.[0].jev).toEqual(v2Edition().sections.answer?.[0].jev);
});

test('the live refresh gives the same result from the stored digest as from the full assessment', () => {
  const noObligations = { obligations: [] as JevAssessment['obligations'] };
  const items = [
    reportItem({ threadId: 'o-reply', score: 7, budgetLane: 'answer', jev: heavyAssessment('r-reply') }),
    reportItem({
      threadId: 'o-waiting',
      score: 5,
      budgetLane: 'know',
      lane: 'follow_up_owed',
      jev: heavyAssessment('r-waiting', {
        obligations: [{ kind: 'waiting', evidence: { messageId: 'm', text: 'w' }, probability: 0.9 }],
      }),
    }),
    reportItem({
      threadId: 'o-change',
      score: 6,
      budgetLane: 'today',
      lane: 'time_sensitive',
      jev: heavyAssessment('r-change', { ...noObligations, meaningfulChange: true }),
    }),
    reportItem({
      threadId: 'o-plain',
      score: 3,
      budgetLane: 'know',
      lane: 'fyi',
      jev: heavyAssessment('r-plain', noObligations),
    }),
  ];
  const full = withOverflow(items);
  const stored = migrateDailyReport(dailyReportForStorage(full), NOW);
  const live = [
    // The selected reply was answered: its slot opens for the overflow.
    thread({ jev: assessment({ sourceRevision: 'answered', obligations: [] }) }),
    // Unchanged evidence keeps the stored item as it is.
    thread({ _id: 'o-reply', jev: heavyAssessment('r-reply') }),
    // The change was settled: a formerly actionable item leaves.
    thread({ _id: 'o-change', jev: assessment({ sourceRevision: 'settled', obligations: [] }) }),
  ];
  const policy = { preferences: DEFAULT_JEV_PREFERENCES, corrections: [] };
  const shape = (report: DailyReport) => ({
    lanes: Object.fromEntries(
      (
        [
          'answer',
          'today',
          'know',
          'overflow',
          'waiting',
          'replyOwed',
          'followUpOwed',
          'timeSensitive',
        ] as const
      ).map((lane) => [
        lane,
        (report.sections[lane] || []).map((item) => `${item.threadId}:${item.lane}:${item.budgetLane}`),
      ]),
    ),
    selected: report.stats.selected,
    overflow: report.stats.overflow,
  });
  const fromFull = shape(projectBriefMail(full, live, policy, NOW + 1000));
  expect(shape(projectBriefMail(stored, live, policy, NOW + 1000))).toEqual(fromFull);
  // The projection did change something, so the digest fields were read.
  expect(fromFull.lanes.overflow).not.toContain('o-change:time_sensitive:today');
  expect(fromFull.lanes.waiting).toContain('o-waiting:follow_up_owed:know');
});

test('a large overflow list with full assessments stays well below the size guard', () => {
  const items = Array.from({ length: 200 }, (_, i) =>
    reportItem({ threadId: `overflow-${i}`, score: 3, budgetLane: 'know', jev: heavyAssessment(`rev-${i}`) }),
  );
  const edition = withOverflow(items);
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
  const fullOverflowBytes = bytes(edition.sections.overflow);
  // The full assessments alone are larger than the whole stored edition may be.
  expect(fullOverflowBytes).toBeGreaterThan(DAILY_REPORT_STORED_BYTE_LIMIT);

  const stored = dailyReportForStorage(edition);
  const storedOverflowBytes = bytes(stored.sections.overflow);
  expect(stored.sections.overflow).toHaveLength(200);
  expect(stored.artifactErrors?.some((error) => error.message.includes('too large'))).toBeFalsy();
  expect(bytes(stored)).toBeLessThan(DAILY_REPORT_STORED_BYTE_LIMIT);
  // About 450 bytes an item instead of about 11 KB.
  expect(storedOverflowBytes / 200).toBeLessThan(600);
  expect(storedOverflowBytes).toBeLessThan(fullOverflowBytes / 20);
});
