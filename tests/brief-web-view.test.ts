import { describe, expect, test } from 'bun:test';
import {
  isBriefEditionGenerating,
  isBriefEditionReadable,
  isBriefEditionRetrying,
} from '../lib/brief/generation';
import { briefLetterFromReport } from '../lib/brief/letter';
import {
  BRIEF_BACKLOG_LIMIT,
  BRIEF_HEAD_IDLE,
  BRIEF_POLL_IDLE_MS,
  BRIEF_POLL_NOTHING_READABLE_MS,
  BRIEF_POLL_PENDING_MS,
  briefEditionServiceIds,
  briefHeadPollInterval,
  briefHeadStamp,
  briefPendingFromHead,
  briefWebEdition,
} from '../lib/brief/web-view';
import { getDailyArt } from '../lib/mail/daily-art';
import type { DailyReport } from '../lib/shared/types';
import { migrateDailyReport } from '../lib/store/daily-reports';
import { realShapeBytes, realShapeEdition } from './fixtures/brief-real-shape';
import { reportItem } from './fixtures/jev';

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

function plainLetterRow(): DailyReport {
  const { document: _document, ...rest } = realShapeEdition();
  return { ...rest, artifactSource: 'deterministic', artifactStatus: 'composing' };
}

describe('the web view of an edition', () => {
  test('a document edition sends its document and four backlog fields, and far fewer bytes', () => {
    const row = realShapeEdition();
    const shape = realShapeBytes(row);
    // The fixture has the size of the owner's edition in production.
    expect(Math.abs(shape.total - 260_000)).toBeLessThan(40_000);
    expect(Math.abs(shape.sections - 221_000)).toBeLessThan(10_000);
    expect(Math.abs(shape.overflow - 118_000)).toBeLessThan(2_000);

    // What the old read sent: the rebuilt legacy artifacts on top of the row.
    const before = bytes({ ...migrateDailyReport(row), art: getDailyArt(row.generatedAt) });
    const view = briefWebEdition(migrateDailyReport(row, Date.now(), { legacyArtifacts: false }));
    const after = bytes(view);
    expect(after).toBeLessThan(before * 0.2);
    expect(after).toBeLessThan(shape.total * 0.25);

    expect(view.html).toBeUndefined();
    expect(view.document).toBeDefined();
    expect(Object.keys(view.sections)).toEqual(['overflow']);
    expect(view.sections.overflow).toHaveLength(BRIEF_BACKLOG_LIMIT);
    expect(Object.keys(view.sections.overflow?.[0] ?? {}).sort()).toEqual([
      'account',
      'subject',
      'threadId',
      'whyItMatters',
    ]);
    // The summary keeps the full count of the edition.
    expect(view.stats?.overflow).toBe(row.sections.overflow?.length);
    expect(view.stats?.noise).toBe(42);
  });

  test('the plain letter from the view equals the plain letter from the full row', () => {
    const row = plainLetterRow();
    const view = briefWebEdition(migrateDailyReport(row, Date.now(), { legacyArtifacts: false }));
    expect(view.artifactSource).toBe('deterministic');
    expect(view.html).toBeUndefined();
    expect(bytes(view)).toBeLessThan(bytes(row) * 0.3);
    const options = { timezone: 'America/New_York' };
    expect(briefLetterFromReport(view as any, options)).toEqual(briefLetterFromReport(row as any, options));
  });

  test('a seven-lane edition stays a seven-lane edition in the letter', () => {
    const { answer: _answer, today: _today, know: _know, ...sections } = plainLetterRow().sections;
    const row = { ...plainLetterRow(), sections } as DailyReport;
    const view = briefWebEdition(row);
    expect(view.sections.answer).toBeUndefined();
    expect(view.sections.replyOwed?.length).toBeGreaterThan(0);
    const options = { timezone: 'UTC' };
    expect(briefLetterFromReport(view as any, options)).toEqual(briefLetterFromReport(row as any, options));
  });

  test('the letter keeps its areas, its people fallback, and an all-day event', () => {
    const row = plainLetterRow();
    row.sections.answer = [reportItem({ sender: undefined, line: undefined, people: ['Maya', 'Lars'] })];
    row.sections.calendar = [
      {
        account: 'account-a',
        eventId: 'all-day',
        title: 'Offsite',
        startAt: row.generatedAt,
        endAt: row.generatedAt + 3_600_000,
        allDay: true,
        scope: 'week',
      },
    ];
    row.sections.albatross = {
      includedAreas: [{ areaId: 'launch', name: 'Launch', reason: 'Support needs an owner.', score: 3 }],
    } as any;
    const view = briefWebEdition(row);
    const options = { timezone: 'UTC' };
    expect(view.sections.answer?.[0].people).toEqual(['Maya']);
    expect(briefLetterFromReport(view as any, options)).toEqual(briefLetterFromReport(row as any, options));
  });

  test('an older model-written page keeps its HTML and area context, and no lanes', () => {
    const row = realShapeEdition();
    delete row.document;
    row.artifactSource = 'ai';
    row.html = '<html><body>Older edition</body></html>';
    row.sections.albatross = { includedAreas: [] } as any;
    const view = briefWebEdition(row);
    expect(view.html).toContain('Older edition');
    expect(view.sections.albatross).toEqual({ includedAreas: [] } as any);
    expect(view.sections.answer).toBeUndefined();
  });

  test('an edition with HTML and no source reads as a model-written page, and one with neither as plain', () => {
    const row = realShapeEdition();
    delete row.document;
    delete row.artifactSource;
    row.html = '<html></html>';
    expect(briefWebEdition(row).artifactSource).toBe('ai');
    delete row.html;
    expect(briefWebEdition(row).artifactSource).toBe('deterministic');
  });

  test('the footer sources come from the edition, without the items', () => {
    const row = realShapeEdition();
    expect(briefEditionServiceIds(row).sort()).toEqual(['calendar', 'github', 'gmail', 'slack', 'tasks']);
    row.sections.tasks = [{ ...row.sections.tasks![0], completedAt: 1 }];
    row.sections.calendar = [];
    expect(briefEditionServiceIds(row)).not.toContain('tasks');
    expect(briefEditionServiceIds(row)).not.toContain('calendar');
    expect(briefEditionServiceIds({ ...row, sections: undefined } as any)).toEqual(['gmail']);
  });

  test('the first and light flags, the retry mark, and the source errors pass through', () => {
    const row = plainLetterRow();
    const view = briefWebEdition({ ...row, first: true, light: true, retrying: true, errors: ['Calendar'] });
    expect(view).toMatchObject({ first: true, light: true, retrying: true, errors: ['Calendar'] });
    expect(briefWebEdition({ ...row, sections: undefined } as any).sections.overflow).toEqual([]);
  });
});

describe('the head of the active job', () => {
  test('no active job is idle, and only a state change moves the stamp', () => {
    expect(briefHeadStamp(null)).toBe(BRIEF_HEAD_IDLE);
    const writing = { reportId: 'r', status: 'partial' as const, artifactStatus: null };
    const later = { ...writing, progress: { stage: 'Mail', done: 3, total: 9 } };
    const composing = { reportId: 'r', status: 'ready' as const, artifactStatus: 'composing' };
    expect(briefHeadStamp(later)).toBe(briefHeadStamp(writing));
    expect(briefHeadStamp(composing)).not.toBe(briefHeadStamp(writing));
    expect(briefHeadStamp({ ...composing, retrying: true })).not.toBe(briefHeadStamp(composing));
  });

  test('a row with text to read is composing, the placeholder is writing, and a retry is neither', () => {
    expect(briefPendingFromHead(null)).toBeNull();
    expect(
      briefPendingFromHead({
        reportId: 'r',
        status: 'partial',
        progress: { stage: 'Mail', done: 1, total: 2 },
      }),
    ).toEqual({ reportId: 'r', phase: 'writing', progress: { stage: 'Mail', done: 1, total: 2 } });
    expect(briefPendingFromHead({ reportId: 'r', status: 'ready', artifactStatus: 'composing' })).toEqual({
      reportId: 'r',
      phase: 'composing',
    });
    expect(
      briefPendingFromHead({ reportId: 'r', status: 'ready', artifactStatus: 'ready', retrying: true }),
    ).toBeNull();
  });

  test('the poll slows down when a reader has something to read', () => {
    const base = { selected: false, pending: false, retrying: false, readable: true };
    expect(briefHeadPollInterval(base)).toBe(BRIEF_POLL_IDLE_MS);
    expect(briefHeadPollInterval({ ...base, selected: true })).toBe(false);
    expect(briefHeadPollInterval({ ...base, pending: true })).toBe(BRIEF_POLL_PENDING_MS);
    expect(briefHeadPollInterval({ ...base, retrying: true })).toBe(BRIEF_POLL_PENDING_MS);
    expect(briefHeadPollInterval({ ...base, pending: true, readable: false })).toBe(
      BRIEF_POLL_NOTHING_READABLE_MS,
    );
  });
});

describe('the one generating rule', () => {
  test('a composing row is still generating and is readable; a placeholder is not readable', () => {
    const composing = { status: 'ready' as const, artifactStatus: 'composing' };
    expect(isBriefEditionGenerating(composing)).toBe(true);
    expect(isBriefEditionReadable(composing)).toBe(true);
    expect(isBriefEditionReadable({ status: 'partial' })).toBe(false);
    expect(isBriefEditionReadable(null)).toBe(false);
    expect(isBriefEditionRetrying({ status: 'ready', retrying: true })).toBe(true);
  });
});
