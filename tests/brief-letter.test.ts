import { describe, expect, test } from 'bun:test';
import {
  BRIEF_LETTER_MEASURE_PX,
  briefLetterFromReport,
  briefLetterHasNoRows,
  briefLetterKind,
  briefLetterLede,
  letterLanesFromSections,
  markWeekdays,
  noiseFooterCopy,
} from '../lib/brief/letter';
import { lintBriefDocument } from '../lib/shared/brief-document';
import {
  areaPulseDocumentFixture,
  letterBriefDocumentFixture,
  quietBriefDocumentFixture,
  richBriefDocumentFixture,
} from '../lib/shared/brief-document-fixtures';
import type { DailyReportItem } from '../lib/shared/types';

const NOW = Date.parse('2026-09-03T12:00:00Z');

function item(threadId: string, subject: string, extra: Partial<DailyReportItem> = {}): DailyReportItem {
  return {
    account: 'jakob@example.com',
    threadId,
    subject,
    people: ['Maya Chen'],
    whyItMatters: 'Maya asked for notes.',
    unread: false,
    ...extra,
  };
}

const emptyLanes = {
  replyOwed: [],
  followUpOwed: [],
  newPeople: [],
  timeSensitive: [],
  tracked: [],
  fyi: [],
  bulkTail: [],
};

describe('briefLetterKind', () => {
  test('the budget document is a daily letter', () => {
    expect(briefLetterKind(letterBriefDocumentFixture)).toBe('daily');
  });

  test('the area pulse document is an area letter', () => {
    expect(briefLetterKind(areaPulseDocumentFixture)).toBe('area');
  });

  test('older free-layout editions are not letters', () => {
    expect(briefLetterKind(richBriefDocumentFixture)).toBeNull();
    expect(briefLetterKind(quietBriefDocumentFixture)).toBeNull();
    expect(briefLetterKind({ regions: [] })).toBeNull();
  });

  test('a letter must start with the lede hero and use each region once', () => {
    const lede = letterBriefDocumentFixture.regions[0];
    const answer = letterBriefDocumentFixture.regions[1];
    expect(briefLetterKind({ regions: [answer, lede] })).toBeNull();
    expect(briefLetterKind({ regions: [lede, answer, answer] })).toBeNull();
    expect(briefLetterKind({ regions: [lede, { ...answer, id: 'signals' }] })).toBeNull();
  });

  test('the lede text and the empty check read the hero', () => {
    expect(briefLetterLede(letterBriefDocumentFixture)).toContain('Two replies wait on you');
    expect(briefLetterLede(richBriefDocumentFixture)).toBe('');
    expect(briefLetterHasNoRows(letterBriefDocumentFixture)).toBe(false);
    expect(briefLetterHasNoRows({ regions: [letterBriefDocumentFixture.regions[0]] })).toBe(true);
  });

  test('the measure is 620 px', () => {
    expect(BRIEF_LETTER_MEASURE_PX).toBe(620);
  });
});

describe('markWeekdays', () => {
  test('marks each weekday name and keeps the rest of the text', () => {
    const segments = markWeekdays('This Thursday you can send the form. Friday is open.');
    expect(segments.map((segment) => segment.text).join('')).toBe(
      'This Thursday you can send the form. Friday is open.',
    );
    expect(segments.filter((segment) => segment.weekday).map((segment) => segment.text)).toEqual([
      'Thursday',
      'Friday',
    ]);
    expect(segments[0]).toEqual({ text: 'This ', weekday: false, start: 0 });
    expect(segments[1].start).toBe(5);
  });

  test('matches plural names and ignores words that contain a name', () => {
    const segments = markWeekdays('Mondays are for planning; the sundial is not a day.');
    expect(segments.filter((segment) => segment.weekday).map((segment) => segment.text)).toEqual(['Mondays']);
  });

  test('returns one plain segment when no weekday is present', () => {
    expect(markWeekdays('Nothing is due.')).toEqual([{ text: 'Nothing is due.', weekday: false, start: 0 }]);
    expect(markWeekdays('')).toEqual([]);
  });
});

describe('noiseFooterCopy', () => {
  test('counts the messages that stayed out', () => {
    expect(noiseFooterCopy(42)).toBe('42 other messages did not need you today.');
    expect(noiseFooterCopy(1)).toBe('1 other message did not need you today.');
  });

  test('prints nothing without a count', () => {
    expect(noiseFooterCopy(0)).toBeNull();
    expect(noiseFooterCopy(-3)).toBeNull();
    expect(noiseFooterCopy(undefined)).toBeNull();
    expect(noiseFooterCopy(null)).toBeNull();
    expect(noiseFooterCopy(Number.NaN)).toBeNull();
  });
});

describe('letterLanesFromSections', () => {
  test('uses the budget lanes when the edition wrote them', () => {
    const lanes = letterLanesFromSections(
      {
        ...emptyLanes,
        answer: [item('a1', 'One'), item('a2', 'Two')],
        today: [],
        know: [item('k1', 'Three')],
        replyOwed: [item('legacy', 'Legacy')],
      },
      'pro',
    );
    expect(lanes.answer.map((row) => row.threadId)).toEqual(['a1', 'a2']);
    expect(lanes.today).toEqual([]);
    expect(lanes.know.map((row) => row.threadId)).toEqual(['k1']);
  });

  test('maps the seven lanes of an older edition onto three, inside the budget', () => {
    const lanes = letterLanesFromSections(
      {
        replyOwed: [item('r1', 'R1'), item('r2', 'R2'), item('r3', 'R3'), item('r4', 'R4')],
        timeSensitive: [item('t1', 'T1'), item('t2', 'T2')],
        followUpOwed: [item('f1', 'F1')],
        tracked: [item('r1', 'R1 again'), item('x1', 'X1')],
        newPeople: [item('n1', 'N1')],
        fyi: [item('y1', 'Y1')],
      },
      'free',
    );
    // free budget: 5. Answer caps at 3, then Today takes the rest.
    expect(lanes.answer.map((row) => row.threadId)).toEqual(['r1', 'r2', 'r3']);
    expect(lanes.today.map((row) => row.threadId)).toEqual(['t1', 't2']);
    expect(lanes.know).toEqual([]);
  });

  test('a thread appears once and an unknown tier reads as pro', () => {
    const lanes = letterLanesFromSections(
      {
        replyOwed: [item('r1', 'R1')],
        timeSensitive: [item('r1', 'R1 again')],
        followUpOwed: [item('f1', 'F1'), item('f2', 'F2'), item('f3', 'F3'), item('f4', 'F4')],
      },
      undefined,
    );
    expect(lanes.answer.map((row) => row.threadId)).toEqual(['r1']);
    expect(lanes.today).toEqual([]);
    expect(lanes.know.map((row) => row.threadId)).toEqual(['f1', 'f2', 'f3']);
  });
});

describe('briefLetterFromReport', () => {
  test('builds the letter layout from a budget edition', () => {
    const document = briefLetterFromReport(
      {
        generatedAt: NOW,
        narrative: 'Narrative fallback.',
        tier: 'pro',
        prose: { lede: 'Two replies wait.', weekAhead: 'Friday is open.' },
        sections: {
          ...emptyLanes,
          answer: [item('a1', 'Review deck', { sender: 'Maya Chen', line: 'Maya asked for notes.' })],
          today: [item('t1', 'Passport form', { line: 'Due today.' })],
          know: [],
          calendar: [
            {
              account: 'jakob@example.com',
              eventId: 'e1',
              title: 'Product review',
              startAt: Date.parse('2026-09-03T14:00:00Z'),
              endAt: Date.parse('2026-09-03T14:30:00Z'),
              location: 'Room 2',
              scope: 'week',
            },
            {
              account: 'jakob@example.com',
              eventId: 'e2',
              title: 'Tomorrow',
              startAt: Date.parse('2026-09-04T14:00:00Z'),
              endAt: Date.parse('2026-09-04T14:30:00Z'),
              scope: 'week',
            },
          ],
          albatross: {
            includedAreas: [
              { areaId: 'area-1', name: 'Home', reason: 'Lease decision.' },
              { areaId: 'area-2', name: 'Product', reason: '' },
              { areaId: 'area-3', name: 'Garden', reason: 'Water.' },
              { areaId: 'area-4', name: 'Fourth', reason: 'Too many.' },
            ],
          },
        },
      },
      { timezone: 'UTC' },
    );
    expect(lintBriefDocument(document)).toEqual([]);
    expect(briefLetterKind(document)).toBe('daily');
    expect(document.title).toBe('The Thursday Brief');
    expect(document.summary).toBe('Two replies wait.');
    expect(document.regions.map((region) => region.id)).toEqual([
      'lede',
      'answer',
      'today',
      'week-ahead',
      'areas',
    ]);
    const answer = document.regions[1].tree;
    if (answer.kind !== 'entity_list') throw new Error('expected entity list');
    expect(answer.title).toBe('Answer');
    expect(answer.items[0].framing).toEqual({
      lane: 'answer',
      reason: 'Maya asked for notes.',
      sender: 'Maya Chen',
    });
    expect(answer.items[0].actions[0]).toMatchObject({ action: 'open_thread', label: 'Open' });
    const today = document.regions[2].tree;
    if (today.kind !== 'entity_list') throw new Error('expected entity list');
    expect(today.items.map((row) => row.ref.kind)).toEqual(['event', 'thread']);
    expect(today.items[0].framing.reason).toBe('2:00 PM to 2:30 PM, Room 2');
    const areas = document.regions[4].tree;
    if (areas.kind !== 'entity_list') throw new Error('expected entity list');
    expect(areas.variant).toBe('compact');
    expect(areas.items.map((row) => row.ref.label)).toEqual(['Home', 'Product', 'Garden']);
    expect(areas.items[1].framing).toEqual({});
  });

  test('an older edition without prose still reads as a letter', () => {
    const document = briefLetterFromReport(
      {
        generatedAt: NOW,
        narrative: 'The older narrative. 🎉',
        sections: {
          replyOwed: [item('r1', 'Reply me')],
          fyi: [item('y1', 'For your information')],
        },
      },
      { timezone: 'UTC' },
    );
    expect(briefLetterKind(document)).toBe('daily');
    expect(document.summary).toBe('The older narrative.');
    expect(document.regions.map((region) => region.id)).toEqual(['lede', 'answer', 'know']);
    const know = document.regions[2].tree;
    if (know.kind !== 'entity_list') throw new Error('expected entity list');
    // The stored why-it-matters is the line when the model wrote none.
    expect(know.items[0].framing.reason).toBe('Maya asked for notes.');
    expect(know.items[0].framing.sender).toBe('Maya Chen');
  });

  test('an edition with nothing to say still has a lede', () => {
    const document = briefLetterFromReport(
      { generatedAt: NOW, narrative: '', sections: {} },
      { timezone: 'UTC' },
    );
    expect(document.regions.map((region) => region.id)).toEqual(['lede']);
    expect(briefLetterLede(document)).toBe('Your brief is ready.');
    expect(briefLetterHasNoRows(document)).toBe(true);
  });
});
