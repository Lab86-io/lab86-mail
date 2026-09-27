import { describe, expect, test } from 'bun:test';
import './tools/harness';
import { composeAreaPulseDocument, fallbackAreaWeekAhead } from '../lib/albatross/area-living-brief';
import { buildAlbatrossDailyReportContext } from '../lib/albatross/daily-report';
import {
  composeBudgetBrief,
  finalizeBudgetReport,
  loadSinceLastEditionFromConvex,
} from '../lib/mail/agent-report';
import { yesterdayFallback } from '../lib/mail/brief-prose';
import { composeReport, WAITING_LIMIT } from '../lib/mail/daily-report';
import type { DailyReport, ThreadInsight, TrackedThread } from '../lib/shared/types';
import { dismissDailyReportThread } from '../lib/store/daily-report-dismissals';
import { withToolContext } from './tools/harness';

const NOW = Date.parse('2026-09-22T11:00:00Z');
const DAY = 86_400_000;
const ACCOUNT = 'jakob@example.com';

function jevWaiting(sourceMessageId: string) {
  return {
    version: 1 as const,
    questionVersion: 'mail-1' as const,
    sourceMessageId,
    sourceRevision: 'rev-1',
    evaluatedAt: NOW,
    model: 'typesafe/jev-1.13',
    status: 'accepted' as const,
    purpose: 'conversation' as const,
    subjectKind: 'general' as const,
    confidence: 0.9,
    obligations: [
      {
        kind: 'waiting' as const,
        evidence: { messageId: sourceMessageId, text: 'I will send it.' },
        probability: 0.9,
      },
    ],
    meaningfulChange: false,
    probabilities: {},
    contextComplete: true,
  };
}

function insight(threadId: string, extra: Partial<ThreadInsight> = {}): ThreadInsight {
  return {
    _id: `${ACCOUNT}:${threadId}`,
    account: ACCOUNT,
    threadId,
    subject: `Subject ${threadId}`,
    summary: 'Summary.',
    people: ['Maya Chen <maya@example.com>'],
    commitments: [],
    openLoops: [],
    needsReply: false,
    waitingOnSomeone: false,
    suggestedTrack: false,
    suggestedCategory: 'main',
    reason: 'Active conversation with Maya.',
    replyOwed: false,
    followUpOwed: false,
    isNewSender: false,
    isPersonal: true,
    isImportant: false,
    isPriorCorrespondent: true,
    briefEligible: true,
    floorProtected: true,
    lane: 'fyi',
    surfacedBecause: [],
    generatedAt: NOW,
    model: 'local',
    ...extra,
  };
}

function tracked(threadId: string, status: TrackedThread['status']): TrackedThread {
  return {
    _id: `tracked-${threadId}`,
    account: ACCOUNT,
    threadId,
    subject: `Tracked ${threadId}`,
    participants: ['Daniel Ruiz <daniel@example.com>'],
    status,
    reason: 'Waiting on Daniel.',
    openLoops: [],
    importance: 2,
    source: 'manual',
    createdAt: NOW - 5 * DAY,
    updatedAt: NOW - DAY,
  };
}

function baseReport(generatedAt = NOW): DailyReport {
  return {
    _id: 'r-now',
    kind: 'morning',
    generatedAt,
    status: 'ready',
    accounts: [ACCOUNT],
    title: 'Morning Daily Report',
    narrative: 'Fallback narrative.',
    sections: {
      replyOwed: [],
      followUpOwed: [],
      newPeople: [],
      timeSensitive: [],
      tracked: [],
      fyi: [],
      bulkTail: [],
      answer: [
        {
          account: ACCOUNT,
          threadId: 't1',
          subject: 'Venue',
          people: ['Maya'],
          whyItMatters: 'Maya asked.',
          unread: false,
          sender: 'Maya',
          firstSurfacedAt: generatedAt - 2 * DAY,
        },
      ],
      calendar: [],
      albatross: {
        ...buildAlbatrossDailyReportContext({ now: generatedAt }),
        dailyAlignment: {
          localDate: '2026-09-21',
          tomorrowIntent: 'finish the deck',
          reflection: 'Slow day.',
        },
      },
    },
    stats: {
      scannedThreads: 0,
      trackedThreads: 0,
      needsReply: 0,
      replyOwed: 0,
      dueSoon: 0,
      bulkTailCount: 0,
      unread: 0,
    },
  };
}

describe('since-last-edition loading', () => {
  test('maps completions and agent operations, and tolerates a failing query', async () => {
    const calls: string[] = [];
    const query = async <T>(_fn: unknown, args: Record<string, unknown>): Promise<T> => {
      calls.push(String(args.since ?? args.limit));
      if ('since' in args) {
        return [
          {
            artifactKind: 'task',
            artifactId: 'c1',
            title: 'Book the venue',
            areaId: 'a1',
            completedAt: NOW - 3_600_000,
          },
        ] as T;
      }
      return [
        {
          agent: 'ai',
          status: 'applied',
          createdAt: NOW - 1_800_000,
          tool: 'archive_thread',
          surface: 'mail',
          summary: 'Archived 12 newsletters',
        },
        {
          agent: 'user',
          status: 'applied',
          createdAt: NOW - 1_800_000,
          tool: 'x',
          surface: 'mail',
          summary: 'By the user',
        },
        {
          agent: 'ai',
          status: 'undone',
          createdAt: NOW - 1_800_000,
          tool: 'x',
          surface: 'mail',
          summary: 'Undone',
        },
        {
          agent: 'ai',
          status: 'applied',
          createdAt: NOW - 3 * DAY,
          tool: 'x',
          surface: 'mail',
          summary: 'Too old',
        },
      ] as T;
    };
    const since = await loadSinceLastEditionFromConvex('u1', NOW - DAY, query);
    expect(since.previousGeneratedAt).toBe(NOW - DAY);
    expect(since.completions).toEqual([
      {
        artifactKind: 'task',
        artifactId: 'c1',
        title: 'Book the venue',
        areaId: 'a1',
        completedAt: NOW - 3_600_000,
      },
    ]);
    expect(since.agentActions.map((row) => row.summary)).toEqual(['Archived 12 newsletters']);
    expect(calls).toHaveLength(2);

    const failing = async <T>(): Promise<T> => {
      throw new Error('down');
    };
    const empty = await loadSinceLastEditionFromConvex('u1', NOW - DAY, failing);
    expect(empty).toEqual({ previousGeneratedAt: NOW - DAY, completions: [], agentActions: [] });
  });

  test('composeBudgetBrief writes the yesterday paragraph and stores the since block', async () => {
    const previous = { ...baseReport(NOW - DAY), _id: 'r-yesterday' };
    let prompt = '';
    const composed = await withToolContext(() =>
      composeBudgetBrief(baseReport(), 'user-1', {
        loadMessages: async () => [],
        loadAreaPulses: async () => [],
        loadWeather: async () => null,
        previous,
        loadSince: async (_userId, since) => ({
          previousGeneratedAt: since,
          completions: [
            { artifactKind: 'task', artifactId: 'c1', title: 'Book the venue', completedAt: NOW },
          ],
          agentActions: [
            { tool: 'archive_thread', surface: 'mail', summary: 'Archived 12 newsletters', createdAt: NOW },
          ],
        }),
        generate: (async (options: any) => {
          prompt = options.prompt;
          return {
            text: JSON.stringify({
              lede: 'Maya waits on the venue.',
              yesterday: 'You wanted the deck done. The venue is booked.',
              items: [],
              weekAhead: 'Friday is open.',
            }),
          };
        }) as any,
      }),
    );
    const data = JSON.parse(prompt.slice(prompt.indexOf('{'), prompt.lastIndexOf('}') + 1));
    expect(data.items[0].carriedDays).toBe(2);
    expect(data.since.completed).toEqual(['Book the venue']);
    expect(data.since.actionsTakenForYou).toEqual(['Archived 12 newsletters']);
    expect(composed.prose.yesterday).toBe('You wanted the deck done. The venue is booked.');
    expect(composed.document.regions.map((region) => region.id)).toEqual([
      'lede',
      'yesterday',
      'answer',
      'week-ahead',
    ]);
    expect(composed.since?.completions[0].title).toBe('Book the venue');

    const finalized = finalizeBudgetReport(baseReport(), composed);
    expect(finalized.prose?.yesterday).toBe('You wanted the deck done. The venue is booked.');
    expect(finalized.sections.since?.agentActions[0].summary).toBe('Archived 12 newsletters');
  });

  test('a failing since loader leaves an empty look back and the deterministic fallback', async () => {
    const composed = await withToolContext(() =>
      composeBudgetBrief(baseReport(), 'user-1', {
        loadMessages: async () => [],
        loadAreaPulses: async () => [],
        loadWeather: async () => null,
        previous: null,
        loadSince: async () => {
          throw new Error('down');
        },
        generate: null,
      }),
    );
    expect(composed.since).toEqual({ previousGeneratedAt: NOW - DAY, completions: [], agentActions: [] });
    expect(composed.prose.yesterday).toBe('You said you wanted to finish the deck.');
  });
});

describe('yesterday fallback branches', () => {
  test('counts several actions and more than three completions', () => {
    expect(
      yesterdayFallback({
        since: {
          previousGeneratedAt: null,
          completed: ['A', 'B', 'C', 'D', 'E'],
          agentActions: ['Archived mail.', 'Filed a receipt'],
        },
      }),
    ).toBe('A, B, and C are done, and 2 more. 2 actions were taken for you, including Archived mail.');
    expect(
      yesterdayFallback({ since: { previousGeneratedAt: null, completed: ['Only one'], agentActions: [] } }),
    ).toBe('Only one is done.');
  });
});

describe('area letter branches', () => {
  test('a delta without pulse lines still gets a pulse region, and undated events get no day', () => {
    const document = composeAreaPulseDocument(
      { area: { areaId: 'area-1', name: 'Studio' } },
      {
        lastChange: '',
        nextMove: '',
        openQuestion: '',
        prose: 'Quiet.',
        weekAhead: '',
        sinceLastBrief: 'Since the last brief: 1 new message.',
      },
    );
    expect(document.regions.map((region) => region.id)).toEqual(['lede', 'pulse', 'ask', 'open-work']);
    expect((document.regions[1].tree as any).children[0].text).toBe('Since the last brief: 1 new message.');
    expect(
      fallbackAreaWeekAhead({
        weekAhead: {
          events: [{ title: 'No date' }, { title: 'Bad', startAtIso: 'not a date' }],
          dueTasks: [],
        },
      }),
    ).toBe('');
  });
});

describe('waiting section in composeReport', () => {
  test('collects jev waiting, follow-up owed, and tracked waiting threads outside the lanes', async () => {
    const insights = [
      insight('answer', { needsReply: true, replyOwed: true, lane: 'reply_owed' }),
      insight('jev', { jev: jevWaiting('m-jev'), lane: 'fyi', isPriorCorrespondent: false }),
      insight('followup', { waitingOnSomeone: true, followUpOwed: true, lane: 'follow_up_owed' }),
      insight('ineligible', { jev: jevWaiting('m-x'), briefEligible: false }),
      insight('plain'),
      insight('over-1'),
      insight('over-2'),
      insight('over-3'),
      insight('overflowed', { jev: jevWaiting('m-over') }),
    ];
    const lastDateByKey = new Map<string, number>([
      [`${ACCOUNT}:answer`, NOW - DAY],
      [`${ACCOUNT}:jev`, NOW - 6 * DAY],
      [`${ACCOUNT}:followup`, NOW - 2 * DAY],
      [`${ACCOUNT}:tracked-wait`, NOW - 4 * DAY],
    ]);
    const report = await withToolContext(() =>
      composeReport({
        kind: 'morning',
        now: NOW,
        accounts: [ACCOUNT],
        insights,
        tracked: [tracked('tracked-wait', 'waiting'), tracked('tracked-open', 'open')],
        lastDateByKey,
        calendarContext: [],
        taskContext: [],
        memoryContext: [],
        albatrossContext: buildAlbatrossDailyReportContext({ now: NOW }),
        errors: [],
        reportId: 'r-compose',
        tier: 'pro',
        // The follow-up thread scores under the floor, so it earns no lane
        // and lands in waiting instead. The overflow thread scores high but
        // finds no room in the know lane, and stays out of waiting.
        scores: new Map([
          [`${ACCOUNT}:followup`, 0],
          [`${ACCOUNT}:over-1`, 9],
          [`${ACCOUNT}:over-2`, 9],
          [`${ACCOUNT}:over-3`, 9],
          [`${ACCOUNT}:overflowed`, 8],
        ]),
      }),
    );
    expect(report.sections.answer?.map((item) => item.threadId)).toEqual(['answer']);
    expect(report.sections.overflow?.map((item) => item.threadId)).toContain('overflowed');
    const waiting = report.sections.waiting ?? [];
    // Longest wait first; the ineligible thread and the open tracked thread stay out.
    expect(waiting.map((item) => item.threadId)).toEqual(['jev', 'tracked-wait', 'followup']);
    expect(waiting.length).toBeLessThanOrEqual(WAITING_LIMIT);
    expect(waiting[0].whyItMatters).toBe('You are waiting for a response or promised work.');
    expect(waiting[0].sender).toBe('Maya Chen');
    expect(waiting[1].sender).toBe('Daniel Ruiz');
    expect(waiting[1].trackedThreadId).toBe('tracked-tracked-wait');
  });
});

test('a thread the reader put away stays out of the edition until newer mail arrives', async () => {
  const user = { userId: 'dismissal_cov_user' };
  const report = await withToolContext(async () => {
    await dismissDailyReportThread({ account: ACCOUNT, threadId: 'put-away', receivedAt: NOW - DAY });
    await dismissDailyReportThread({ account: ACCOUNT, threadId: 'came-back', receivedAt: NOW - 3 * DAY });
    return composeReport({
      kind: 'morning',
      now: NOW,
      accounts: [ACCOUNT],
      insights: [
        insight('put-away', { lane: 'reply_owed', needsReply: true, replyOwed: true }),
        insight('came-back', { lane: 'reply_owed', needsReply: true, replyOwed: true }),
      ],
      tracked: [],
      lastDateByKey: new Map([
        [`${ACCOUNT}:put-away`, NOW - DAY],
        [`${ACCOUNT}:came-back`, NOW - DAY],
      ]),
      calendarContext: [],
      taskContext: [],
      memoryContext: [],
      albatrossContext: buildAlbatrossDailyReportContext({ now: NOW }),
      errors: [],
      reportId: 'r-dismissed',
      tier: 'pro',
    });
  }, user);
  const shown = Object.values(report.sections)
    .filter(Array.isArray)
    .flat()
    .map((item: any) => item?.threadId)
    .filter(Boolean);
  expect(shown).not.toContain('put-away');
  expect(shown).toContain('came-back');
});
