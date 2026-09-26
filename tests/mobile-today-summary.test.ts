import { describe, expect, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { createMobileTodaySummaryGet } from '../app/api/mobile/v1/today/summary/route';
import { AuthRequiredError } from '../lib/auth/current-user';
import { MobileContractV1, TodaySummarySchema } from '../lib/mobile/v1/contract';
import { mobileOpenAPIV1 } from '../lib/mobile/v1/openapi';
import {
  buildTodaySummary,
  firstSentence,
  loadTodaySummary,
  TODAY_SUMMARY_NO_EDITION,
  TODAY_SUMMARY_READY,
} from '../lib/mobile/v1/today-summary';
import type { DailyReport } from '../lib/shared/types';
import { setDailyReportReaderForTest } from '../lib/store/daily-reports';

const NOW = Date.parse('2026-09-28T13:00:00Z');

function report(
  extra: Partial<DailyReport['sections']> = {},
  prose = 'Two replies wait on you. The review is at ten.',
) {
  return {
    _id: 'r1',
    kind: 'morning',
    generatedAt: NOW - 3600_000,
    accounts: ['a1'],
    title: 'Brief',
    narrative: prose,
    prose: { lede: prose, weekAhead: '', model: 'local' },
    sections: {
      answer: [
        {
          account: 'a1',
          threadId: 't1',
          subject: 'Deck notes',
          people: [],
          whyItMatters: 'Maya asked for notes before Thursday. She needs them soon.',
          unread: true,
        },
      ],
      ...extra,
    },
    stats: {},
  } as unknown as DailyReport;
}

describe('the Today summary', () => {
  test('reads the lead line, the next move, and the next meeting', () => {
    const summary = buildTodaySummary({
      report: report(),
      events: [
        { providerEventId: 'all-day', title: 'Holiday', startAt: NOW, endAt: NOW + 86_400_000, allDay: true },
        { providerEventId: 'past', title: 'Done', startAt: NOW - 7200_000, endAt: NOW - 3600_000 },
        {
          providerEventId: 'later',
          accountId: 'a1',
          title: 'Review',
          startAt: NOW + 3600_000,
          endAt: NOW + 7200_000,
          location: 'Room 4',
        },
        { providerEventId: 'running', title: 'Standup', startAt: NOW - 600_000, endAt: NOW + 600_000 },
      ],
      attention: 2,
      now: NOW,
    });
    expect(summary).toEqual({
      version: 1,
      reportID: 'r1',
      kind: 'morning',
      generatedAt: new Date(NOW - 3600_000).toISOString(),
      leadLine: 'Two replies wait on you.',
      nextMove: {
        title: 'Deck notes',
        detail: 'Maya asked for notes before Thursday.',
        refKind: 'thread',
        refID: 't1',
        accountID: 'a1',
      },
      nextMeeting: {
        eventID: 'running',
        title: 'Standup',
        startAt: new Date(NOW - 600_000).toISOString(),
        endAt: new Date(NOW + 600_000).toISOString(),
      },
      sourcesNeedingAttention: 2,
      serverTime: new Date(NOW).toISOString(),
    });
    expect(TodaySummarySchema.parse(summary)).toEqual(summary);
  });

  test('falls back to a task, and says plainly when there is no edition', () => {
    const tasks = buildTodaySummary({
      report: report(
        {
          answer: [],
          tasks: [
            {
              cardId: 'late',
              boardId: 'b',
              columnId: 'c',
              title: 'Later',
              dueAt: NOW + 86_400_000,
              scope: 'week',
            },
            {
              cardId: 'soon',
              boardId: 'b',
              columnId: 'c',
              title: 'Soon',
              dueAt: NOW + 3600_000,
              scope: 'week',
            },
            {
              cardId: 'done',
              boardId: 'b',
              columnId: 'c',
              title: 'Done',
              dueAt: NOW,
              completedAt: NOW,
              scope: 'week',
            },
          ],
        },
        '',
      ),
      events: [],
      attention: 0,
      now: NOW,
    });
    expect(tasks.nextMove).toEqual({ title: 'Soon', refKind: 'task', refID: 'soon' });
    expect(tasks.leadLine).toBe(TODAY_SUMMARY_READY);
    expect(tasks.nextMeeting).toBeUndefined();
    const today = buildTodaySummary({
      report: report({
        answer: [],
        today: [{ account: 'a1', threadId: 't2', subject: '', people: [], whyItMatters: '', unread: false }],
      }),
      events: [],
      attention: 0,
      now: NOW,
    });
    expect(today.nextMove).toEqual({
      title: '(no subject)',
      refKind: 'thread',
      refID: 't2',
      accountID: 'a1',
    });
    const empty = buildTodaySummary({ report: null, events: [], attention: 1.7, now: NOW });
    expect(empty).toEqual({
      version: 1,
      leadLine: TODAY_SUMMARY_NO_EDITION,
      sourcesNeedingAttention: 1,
      serverTime: new Date(NOW).toISOString(),
    });
  });

  test('cuts a long first sentence at a word', () => {
    expect(firstSentence('')).toBe('');
    expect(firstSentence('No end mark here')).toBe('No end mark here');
    const long = `${'word '.repeat(80)}end.`;
    const cut = firstSentence(long, 60);
    expect(cut.length).toBeLessThanOrEqual(60);
    expect(cut.endsWith('…')).toBe(true);
    expect(firstSentence('x'.repeat(100), 20)).toBe(`${'x'.repeat(19)}…`);
  });

  test('loads the latest edition inside the user context, and survives a calendar or source failure', async () => {
    let userSeen = '';
    const summary = await loadTodaySummary('u1', {
      latest: async (userId: string) => {
        userSeen = userId;
        return report();
      },
      events: async () => {
        throw new Error('calendar down');
      },
      attention: async () => {
        throw new Error('convex down');
      },
      now: () => NOW,
    });
    expect(userSeen).toBe('u1');
    expect(summary.sourcesNeedingAttention).toBe(0);
    expect(summary.nextMeeting).toBeUndefined();

    // The default reader runs the live edition read in the user's context.
    setDailyReportReaderForTest({
      configured: () => true,
      load: (async () => report()) as any,
      loadDismissals: async () => ({}),
      loadClosedTracked: async () => new Set(),
      loadSelfAddresses: async () => new Set(),
      loadOperationStates: async () => new Map(),
      loadPolicy: (async () => ({ preferences: {}, corrections: [], revision: 0 })) as any,
      query: (async (fn: any) =>
        getFunctionName(fn) === 'userData:dailyReportPage'
          ? { page: [report()], isDone: true, continueCursor: '' }
          : []) as any,
    });
    try {
      const live = await loadTodaySummary('u1', {
        events: async () => [],
        attention: async () => 0,
        now: () => NOW,
      });
      expect(live).toMatchObject({ reportID: 'r1', leadLine: 'Two replies wait on you.' });
    } finally {
      setDailyReportReaderForTest();
    }
  });
});

describe('the Today summary route and contract', () => {
  test('answers the signed-in user and maps errors', async () => {
    const ok = createMobileTodaySummaryGet({
      requireCurrentUser: async () => ({ userId: 'u1' }) as any,
      loadTodaySummary: async () => buildTodaySummary({ report: null, events: [], attention: 0, now: NOW }),
    });
    const response = await ok(new Request('https://mail.example.com/api/mobile/v1/today/summary'));
    expect(response.status).toBe(200);
    expect((await response.json()).leadLine).toBe(TODAY_SUMMARY_NO_EDITION);
    const denied = createMobileTodaySummaryGet({
      requireCurrentUser: async () => {
        throw new AuthRequiredError('Sign in required.');
      },
      loadTodaySummary: async () => {
        throw new Error('unused');
      },
    });
    expect((await denied(new Request('https://mail.example.com/x'))).status).toBe(401);
  });

  test('the contract and the OpenAPI document carry the summary', () => {
    expect(MobileContractV1.schemas.TodaySummary).toBe(TodaySummarySchema);
    const document = mobileOpenAPIV1() as any;
    expect(document.paths['/api/mobile/v1/today/summary'].get.operationId).toBe('getMobileTodaySummary');
    expect(document.components.schemas.TodaySummary.required).toEqual(
      expect.arrayContaining(['version', 'leadLine', 'sourcesNeedingAttention', 'serverTime']),
    );
  });
});
