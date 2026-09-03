import { describe, expect, test } from 'bun:test';
import { budgetAreaLines } from '../lib/mail/brief-areas';
import { BUDGET_TODAY_EVENT_LIMIT, composeBudgetBriefDocument } from '../lib/mail/brief-budget-document';
import { briefTierForPlan, resolveBriefPlanTier } from '../lib/mail/brief-plan';
import { lintBriefDocument } from '../lib/shared/brief-document';
import type { DailyReport, DailyReportCalendarItem, DailyReportItem } from '../lib/shared/types';

const NOW = Date.parse('2026-09-03T12:00:00Z');
const TZ = 'America/New_York';

function item(threadId: string, subject: string, sender?: string): DailyReportItem {
  return {
    account: 'jakob@example.com',
    threadId,
    subject,
    people: sender ? [sender] : [],
    sender,
    whyItMatters: 'x',
    unread: false,
  };
}

function event(
  id: string,
  title: string,
  iso: string,
  extra: Partial<DailyReportCalendarItem> = {},
): DailyReportCalendarItem {
  return {
    account: 'jakob@example.com',
    eventId: id,
    title,
    startAt: Date.parse(iso),
    endAt: Date.parse(iso) + 1_800_000,
    scope: 'week',
    ...extra,
  };
}

function report(
  overrides: Partial<DailyReport['sections']> = {},
): Pick<DailyReport, 'generatedAt' | 'sections' | 'narrative'> {
  return {
    generatedAt: NOW,
    narrative: 'Fallback narrative.',
    sections: {
      replyOwed: [],
      followUpOwed: [],
      newPeople: [],
      timeSensitive: [],
      tracked: [],
      fyi: [],
      bulkTail: [],
      calendar: [],
      ...overrides,
    },
  };
}

describe('composeBudgetBriefDocument', () => {
  test('empty day: lede and week ahead only', () => {
    const document = composeBudgetBriefDocument({
      report: report(),
      prose: { lede: 'A quiet day.', weekAhead: 'Friday is open.', lines: {} },
      timezone: TZ,
    });
    expect(document.regions.map((region) => region.id)).toEqual(['lede', 'week-ahead']);
    expect(document.title).toBe('The Thursday Brief');
    expect(document.timezone).toBe(TZ);
    expect(lintBriefDocument(document)).toEqual([]);
  });

  test('uses the narrative when the lede is blank and skips a blank week ahead', () => {
    const document = composeBudgetBriefDocument({
      report: report(),
      prose: { lede: '  ', weekAhead: '', lines: {} },
      timezone: TZ,
    });
    expect(document.regions.map((region) => region.id)).toEqual(['lede']);
    expect(document.summary).toBe('Fallback narrative.');
  });

  test('today lane lists at most four of today events before the deadline threads', () => {
    const calendar = [
      event('e1', 'One', '2026-09-03T13:00:00Z', { location: 'Room 2' }),
      event('e2', 'Two', '2026-09-03T14:00:00Z'),
      event('e3', 'Three', '2026-09-03T15:00:00Z'),
      event('e4', 'Four', '2026-09-03T16:00:00Z'),
      event('e5', 'Five', '2026-09-03T17:00:00Z'),
      event('e6', 'Tomorrow', '2026-09-04T17:00:00Z'),
      event('e7', 'All day', '2026-09-03T04:00:00Z', { allDay: true }),
    ];
    const document = composeBudgetBriefDocument({
      report: report({ calendar, today: [item('t1', 'Form due', 'Ana')] }),
      prose: { lede: 'L.', weekAhead: 'W.', lines: { 'jakob@example.com:t1': 'Send it before 5.' } },
      timezone: TZ,
    });
    const today = document.regions.find((region) => region.id === 'today')?.tree as any;
    expect(today.title).toBe('Today');
    expect(today.items).toHaveLength(BUDGET_TODAY_EVENT_LIMIT + 1);
    expect(today.items[0]).toEqual({
      ref: { kind: 'event', id: 'e7', account: 'jakob@example.com', label: 'All day' },
      framing: { lane: 'today', reason: 'All day' },
      actions: [
        {
          action: 'open_event',
          label: 'Open',
          payload: { account: 'jakob@example.com', eventId: 'e7' },
          style: 'quiet',
        },
      ],
    });
    expect(today.items[1].framing.reason).toBe('9:00 AM to 9:30 AM, Room 2');
    expect(today.items[4].ref).toMatchObject({ kind: 'thread', id: 't1' });
    expect(today.items[4].framing).toEqual({ lane: 'today', reason: 'Send it before 5.', sender: 'Ana' });
    expect(document.regions.find((region) => region.id === 'today')?.summary).toBe(
      'Today: 4 events; 1 deadline: Ana.',
    );
  });

  test('answer and know lanes carry the thread refs and omit blank lines and senders', () => {
    const document = composeBudgetBriefDocument({
      report: report({
        answer: [item('a1', 'Venue', 'Maya'), item('a2', '', undefined)],
        know: [item('k1', 'Notes', 'Ben')],
      }),
      prose: { lede: 'L.', weekAhead: 'W.', lines: { 'jakob@example.com:a1': 'Pick one.' } },
      timezone: TZ,
    });
    expect(document.regions.map((region) => region.id)).toEqual(['lede', 'answer', 'know', 'week-ahead']);
    const answer = document.regions[1].tree as any;
    expect(answer.emphasis).toBe('primary');
    expect(answer.items[0].framing).toEqual({ lane: 'answer', reason: 'Pick one.', sender: 'Maya' });
    expect(answer.items[1].ref.label).toBe('(no subject)');
    expect(answer.items[1].framing).toEqual({ lane: 'answer' });
    expect(document.regions[1].summary).toBe('Answer: 2 replies owed: Maya.');
    expect(document.regions[2].summary).toBe('Know: 1 thread: Ben.');
    expect(lintBriefDocument(document)).toEqual([]);
  });

  test('areas region is compact, capped at three, and skips unnamed areas', () => {
    const document = composeBudgetBriefDocument({
      report: report(),
      prose: { lede: 'L.', weekAhead: 'W.', lines: {} },
      areas: [
        { areaId: 'a1', name: 'One', line: 'Do one.' },
        { areaId: 'a2', name: 'Two', line: '' },
        { areaId: '', name: 'Nameless id', line: 'x' },
        { areaId: 'a3', name: 'Three', line: 'Do three.' },
        { areaId: 'a4', name: 'Four', line: 'Do four.' },
      ],
      timezone: TZ,
    });
    const areas = document.regions.find((region) => region.id === 'areas')?.tree as any;
    expect(areas.variant).toBe('compact');
    expect(areas.items.map((entry: any) => entry.ref.id)).toEqual(['a1', 'a2', 'a3']);
    expect(areas.items[1].framing).toEqual({});
    expect(areas.items[0].actions[0]).toEqual({
      action: 'open_area',
      label: 'Open',
      payload: { areaId: 'a1' },
      style: 'quiet',
    });
  });
});

describe('budgetAreaLines', () => {
  const context = {
    includedAreas: [
      { areaId: 'a1', name: 'Launch', reason: 'Live work' },
      { areaId: 'a2', name: 'House', reason: 'Quiet' },
      { areaId: 'a1', name: 'Launch again' },
    ],
    askBeforeCentering: [
      { areaId: 'a3', name: 'Studio', prompt: 'Include the studio today?' },
      { areaId: 'a4', name: 'Extra', prompt: 'x' },
    ],
    activeIntents: [{ id: 'i1', text: 'Plan the party', areaId: 'a2', status: 'ready' }],
    activeProjects: [{ id: 'p1', title: 'Ship it', areaId: 'a1', status: 'active' }],
    contextReview: [],
    completions: [],
  };

  test('prefers the pulse, then the context line, then the reason; caps at three', () => {
    const lines = budgetAreaLines(context as any, [
      {
        areaId: 'a1',
        pulse: {
          nextMove: 'Send the note to Maya. Then rest.',
          lastChange: 'x',
          openQuestion: '',
          prose: '',
        },
      },
      { areaId: 'a2', pulse: { nextMove: '', lastChange: '', openQuestion: 'Which caterer?', prose: '' } },
    ]);
    expect(lines).toEqual([
      { areaId: 'a1', name: 'Launch', line: 'Send the note to Maya.' },
      { areaId: 'a2', name: 'House', line: 'Which caterer?' },
      { areaId: 'a3', name: 'Studio', line: 'Include the studio today?' },
    ]);
  });

  test('falls back to the report context and handles missing context', () => {
    expect(budgetAreaLines(null)).toEqual([]);
    const lines = budgetAreaLines({
      ...context,
      includedAreas: [{ areaId: 'a5', name: 'Bare', reason: 'Only a reason' }],
      askBeforeCentering: [],
    } as any);
    expect(lines).toEqual([{ areaId: 'a5', name: 'Bare', line: 'Only a reason' }]);
  });
});

describe('brief plan tier', () => {
  test('maps entitlement plans to tiers and defaults to pro', async () => {
    expect(briefTierForPlan('free')).toBe('free');
    expect(briefTierForPlan('byok')).toBe('pro');
    expect(briefTierForPlan('pro')).toBe('pro');
    expect(briefTierForPlan('admin')).toBe('team');
    expect(briefTierForPlan('mystery')).toBe('pro');
    expect(await resolveBriefPlanTier(null)).toBe('pro');
    expect(await resolveBriefPlanTier('u', { query: async () => ({ entitlement: { plan: 'free' } }) })).toBe(
      'free',
    );
    expect(await resolveBriefPlanTier('u', { query: async () => ({ entitlement: null }) })).toBe('pro');
    expect(
      await resolveBriefPlanTier('u', {
        query: async () => {
          throw new Error('offline');
        },
      }),
    ).toBe('pro');
  });
});
