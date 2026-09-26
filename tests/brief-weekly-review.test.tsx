import { describe, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getFunctionName } from 'convex/server';
import { renderToStaticMarkup } from 'react-dom/server';
import './tools/harness';
import {
  BriefCanvas,
  briefActionHidesItem,
  executeBriefAction,
  undoBriefActionWithFeedback,
} from '../components/report/brief-canvas/BriefCanvas';
import { briefLetterKind } from '../lib/brief/letter';
import { generateWeeklyReview } from '../lib/brief/weekly';
import {
  composeWeeklyReviewDocument,
  deferTarget,
  nextMondayMorning,
  WEEKLY_REVIEW_TITLE,
  weeklyLede,
  weeklyTasks,
} from '../lib/brief/weekly-document';
import { DEFAULT_JEV_PREFERENCES, type JevAssessment } from '../lib/jev/contract';
import { projectBriefMail } from '../lib/jev/report';
import { runBriefJob } from '../lib/mail/brief-jobs';
import { notifyBriefReady, WEEKLY_REVIEW_READY_TITLE } from '../lib/mail/brief-ready';
import { BriefEditionKindSchema, MobileContractV1 } from '../lib/mobile/v1/contract';
import type { DailyReport, DailyReportTaskItem, Thread } from '../lib/shared/types';

const TZ = 'America/New_York';
// Sunday 2026-09-27, 07:00 New York.
const SUNDAY = Date.parse('2026-09-27T11:00:00Z');
const DAY = 86_400_000;

function jev(kinds: Array<'reply' | 'action' | 'waiting'>): JevAssessment {
  return {
    version: 1,
    questionVersion: 'mail-1',
    sourceMessageId: 'm1',
    sourceRevision: 'rev-1',
    evaluatedAt: SUNDAY,
    model: 'jev',
    status: 'accepted',
    purpose: 'conversation',
    subjectKind: 'general',
    confidence: 0.9,
    obligations: kinds.map((kind) => ({
      kind,
      evidence: { messageId: 'm1', text: 'Evidence.' },
      probability: 0.9,
    })),
    meaningfulChange: false,
    probabilities: {},
    contextComplete: true,
  };
}

function thread(id: string, kinds: Array<'reply' | 'action' | 'waiting'>, lastDate = SUNDAY - DAY): Thread {
  return {
    _id: id,
    account: 'a1',
    subject: `Subject ${id}`,
    fromAddress: 'Maya Chen <maya@example.com>',
    lastDate,
    labels: ['INBOX'],
    unread: false,
    jev: jev(kinds),
  } as Thread;
}

function task(cardId: string, dueAt: number | null, completedAt: number | null = null): DailyReportTaskItem {
  return { cardId, boardId: 'b', columnId: 'c', title: `Task ${cardId}`, dueAt, completedAt, scope: 'week' };
}

describe('weekly review dates and counts', () => {
  test('Defer moves to next Monday morning, or a week past a later due date', () => {
    const monday = nextMondayMorning(SUNDAY, TZ);
    expect(new Date(monday).toISOString()).toBe('2026-09-28T13:00:00.000Z');
    // A Monday review defers to the Monday after.
    expect(new Date(nextMondayMorning(monday, TZ)).toISOString()).toBe('2026-10-05T13:00:00.000Z');
    expect(deferTarget(null, monday)).toBe(monday);
    expect(deferTarget(monday - DAY, monday)).toBe(monday);
    expect(deferTarget(monday + DAY, monday)).toBe(monday + 8 * DAY);
  });

  test('splits open tasks into due by the week end and due next week', () => {
    const split = weeklyTasks(
      [
        task('overdue', SUNDAY - 2 * DAY),
        task('today', SUNDAY + 3600_000),
        task('tuesday', SUNDAY + 2 * DAY),
        task('far', SUNDAY + 20 * DAY),
        task('none', null),
        task('done', SUNDAY - DAY, SUNDAY - DAY),
      ],
      SUNDAY,
      TZ,
    );
    expect(split.dueNow.map((row) => row.cardId)).toEqual(['overdue', 'today']);
    expect(split.dueNext.map((row) => row.cardId)).toEqual(['tuesday']);
  });

  test('the lede says the counts plainly', () => {
    expect(weeklyLede({ done: 3, open: 2, waiting: 1, events: 4, due: 1 })).toBe(
      'This week you finished 3 things. 2 items are still open, and you are waiting on 1 reply. Next week has 4 events and 1 task due. Defer or drop what will not happen, and the rest is your plan.',
    );
    expect(weeklyLede({ done: 0, open: 0, waiting: 2, events: 0, due: 0 })).toBe(
      'Nothing was marked finished this week. Nothing is open on your side, and you are waiting on 2 replies. Next week is clear so far. Defer or drop what will not happen, and the rest is your plan.',
    );
    expect(weeklyLede({ done: 1, open: 1, waiting: 0, events: 1, due: 0 })).toContain(
      '1 item is still open.',
    );
    expect(weeklyLede({ done: 1, open: 0, waiting: 0, events: 0, due: 0 })).toContain(
      'Nothing is open on your side.',
    );
  });
});

describe('the weekly review edition', () => {
  async function generate() {
    const saved: DailyReport[] = [];
    const report = await generateWeeklyReview({ userId: 'u1', reportId: 'weekly-1', now: SUNDAY }, {
      loadCompletions: async () => [
        {
          artifactKind: 'intent',
          artifactId: 'w1',
          title: 'Ship the deck',
          completedAt: SUNDAY - 2 * DAY,
          areaId: 'area1',
        },
        { artifactKind: 'task', artifactId: 't-done', title: 'Pay rent', completedAt: SUNDAY - 3 * DAY },
        { artifactKind: 'task', artifactId: 't-done', title: 'Pay rent', completedAt: SUNDAY - 3 * DAY },
        { artifactKind: 'task', artifactId: '', title: 'No id', completedAt: SUNDAY },
      ],
      loadAttention: async () => [
        thread('reply', ['reply']),
        thread('wait', ['waiting'], SUNDAY - 4 * DAY),
        thread('both', ['waiting', 'action'], SUNDAY - 2 * DAY),
      ],
      loadTasks: async () => [
        task('open-now', SUNDAY - DAY),
        task('next', SUNDAY + 3 * DAY),
        task('t-done', SUNDAY - 3 * DAY, SUNDAY - 3 * DAY),
        task('other-done', SUNDAY - 2 * DAY, SUNDAY - 1 * DAY),
      ],
      loadCalendar: async () => [
        {
          account: 'a1',
          eventId: 'e1',
          title: 'Board review',
          startAt: SUNDAY + DAY + 3600_000,
          endAt: SUNDAY + DAY + 7200_000,
          scope: 'week',
        },
        {
          account: 'a1',
          eventId: 'e2',
          title: 'Offsite',
          startAt: SUNDAY + 2 * DAY,
          endAt: SUNDAY + 3 * DAY,
          allDay: true,
          location: 'Denver',
          scope: 'week',
        },
      ],
      save: async (report: DailyReport) => {
        saved.push(report);
        return report;
      },
      timezone: async () => TZ,
    } as any);
    return { report, saved };
  }

  test('reads the week and stores a deterministic review', async () => {
    const { report, saved } = await generate();
    expect(saved).toHaveLength(1);
    expect(report).toMatchObject({
      kind: 'weekly',
      status: 'ready',
      title: WEEKLY_REVIEW_TITLE,
      model: 'local',
    });
    expect(report.sections.weekly?.done.map((item) => `${item.kind}:${item.id}`)).toEqual([
      'task:other-done',
      'work:w1',
      'task:t-done',
    ]);
    expect(report.sections.answer?.map((item) => item.threadId).sort()).toEqual(['both', 'reply']);
    expect(report.sections.waiting?.map((item) => item.threadId)).toEqual(['wait']);
    const document = report.document!;
    expect(document.regions.map((region) => region.id)).toEqual([
      'lede',
      'done',
      'open',
      'waiting',
      'next-week',
    ]);
    expect(briefLetterKind(document)).toBe('weekly');
    expect(report.narrative).toBe(document.summary);
    expect(document.summary).toContain('This week you finished 3 things.');
    const open = document.regions.find((region) => region.id === 'open')!.tree as any;
    expect(open.title).toBe('Still open');
    const threadActions = open.items[0].actions.map((action: any) => `${action.action}:${action.label}`);
    expect(threadActions).toEqual(['open_thread:Open', 'defer_thread:Defer', 'dismiss_thread:Drop']);
    expect(open.items[0].actions[1].payload.until).toBe(nextMondayMorning(SUNDAY, TZ));
    const taskRow = open.items.find((item: any) => item.ref.kind === 'task');
    expect(taskRow.actions.map((action: any) => `${action.action}:${action.label}`)).toEqual([
      'toggle_task:Done',
      'defer_task:Defer',
      'dismiss_task:Drop',
    ]);
    expect(taskRow.actions[1].payload).toMatchObject({ cardId: 'open-now', previousDueAt: SUNDAY - DAY });
    const next = document.regions.find((region) => region.id === 'next-week')!.tree as any;
    expect(next.items.map((item: any) => item.ref.kind)).toEqual(['event', 'event', 'task']);
    expect(next.items[1].framing.reason).toContain('all day, Denver');
    const done = document.regions.find((region) => region.id === 'done')!.tree as any;
    expect(done.items.find((item: any) => item.ref.kind === 'work').actions[0]).toMatchObject({
      action: 'open_work',
      payload: { workId: 'w1', areaId: 'area1' },
    });
  });

  test('the live read keeps the weekly layout and recounts after a handled item leaves', async () => {
    const { report } = await generate();
    const live = projectBriefMail(
      report,
      [],
      { preferences: DEFAULT_JEV_PREFERENCES, corrections: [] },
      SUNDAY + 3600_000,
      { threads: new Set(['a1:reply']) },
    );
    expect(briefLetterKind(live.document!)).toBe('weekly');
    const open = live.document!.regions.find((region) => region.id === 'open')!.tree as any;
    expect(open.items.some((item: any) => item.ref.id === 'reply')).toBe(false);
    expect(live.narrative).toBe(live.document!.summary);
  });

  test('a review with only a lede and waiting still reads as a review', () => {
    const document = composeWeeklyReviewDocument(
      {
        generatedAt: SUNDAY,
        sections: {
          waiting: [
            {
              account: 'a1',
              threadId: 'w',
              subject: 'Contract',
              people: [],
              whyItMatters: 'Waiting.',
              unread: false,
            },
          ],
        } as unknown as DailyReport['sections'],
      },
      TZ,
    );
    expect(document.regions.map((region) => region.id)).toEqual(['lede', 'waiting']);
    expect(briefLetterKind(document)).toBe('weekly');
    expect(briefLetterKind({ ...document, title: 'Other' })).toBe('daily');
  });

  test('the web renders the review under its own masthead title', async () => {
    const { report } = await generate();
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <BriefCanvas value={report.document} masthead />
      </QueryClientProvider>,
    );
    expect(html).toContain('The Weekly Review');
    expect(html).toContain('data-brief-letter="weekly"');
    expect(html).toContain('daily-brief-layout');
    expect(html).toContain('>Done this week</span>');
    expect(html).toContain('>Still open</span>');
    expect(html).toContain('>Next week</span>');
    expect(html).toContain('data-brief-letter-action-name="defer_thread"');
    expect(html).not.toMatch(/\bAI\b/);
  });
});

describe('the weekly review job and delivery', () => {
  test('the job writes the review once, records it, and announces it', async () => {
    const calls: Array<{ name: string; args: any }> = [];
    const deps = {
      mutation: (async (fn: any, args: any) => {
        const name = getFunctionName(fn);
        calls.push({ name, args });
        if (name === 'briefJobs:claim')
          return {
            kind: 'daily',
            edition: 'weekly',
            reportId: 'weekly-1',
            createdAt: SUNDAY,
            attempts: 1,
            timezone: TZ,
          };
        return true;
      }) as any,
      query: (async () => null) as any,
      telemetry: mock(async () => {}),
      daily: mock(async () => ({})),
      weekly: mock(async () => ({ _id: 'weekly-1', kind: 'weekly', generatedAt: SUNDAY })),
      area: mock(async () => ({})),
      narrative: mock(async () => ({})),
      readDaily: mock(async () => null),
      notify: mock(async () => {}),
      noAccess: mock(async () => false),
      now: () => 100,
    };
    await runBriefJob('owner', 'job', deps as any);
    expect(deps.weekly.mock.calls[0][0]).toEqual({ userId: 'owner', reportId: 'weekly-1', now: SUNDAY });
    expect(deps.daily).not.toHaveBeenCalled();
    expect(deps.telemetry).toHaveBeenCalledTimes(1);
    expect(deps.notify.mock.calls[0][1]).toBe('weekly');
    expect(calls.at(-1)?.args.error).toBeUndefined();
  });

  test('the Sunday review push names itself', async () => {
    const queued: any[] = [];
    const deps = {
      queueBriefReady: async (input: any) => {
        queued.push(input);
        return { notificationId: 'n1' };
      },
      dispatchNativeNotification: async () => ({ sent: 1 }),
    } as any;
    await notifyBriefReady(
      'u1',
      'weekly',
      { _id: 'w', generatedAt: SUNDAY, narrative: 'Three things.' },
      TZ,
      deps,
    );
    await notifyBriefReady('u1', 'manual', { _id: 'm', generatedAt: SUNDAY }, TZ, deps);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      title: WEEKLY_REVIEW_READY_TITLE,
      body: 'Three things.',
      localDate: '2026-09-27',
    });
  });

  test('Defer and Drop run the real tools, and Defer is undoable', async () => {
    const original = globalThis.fetch;
    const requests: Array<{ url: string; body: any }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ ok: true, result: { ok: true, operationId: 'op-due' } }));
    }) as typeof fetch;
    try {
      const future = Date.now() + DAY;
      const result = await executeBriefAction('defer_task', { cardId: 'c1', dueAt: future }, () => {});
      expect(result).toMatchObject({ operationId: 'op-due' });
      expect(requests[0]).toEqual({
        url: '/api/tools/tasks_update_card',
        body: { cardId: 'c1', dueIso: new Date(future).toISOString() },
      });
      await executeBriefAction('defer_thread', { account: 'a1', threadId: 't1', until: future }, () => {});
      expect(requests[1]).toEqual({
        url: '/api/tools/snooze_thread',
        body: { account: 'a1', threadId: 't1', untilTs: future },
      });
      const handlers = { onUndone: () => {}, onFailed: () => {} };
      await undoBriefActionWithFeedback('defer_task', { operationId: 'op-due' }, handlers);
      await undoBriefActionWithFeedback('defer_thread', { account: 'a1', threadId: 't1' }, handlers);
      expect(requests.slice(2)).toEqual([
        { url: '/api/tools/undo_operation', body: { operationId: 'op-due' } },
        { url: '/api/tools/unsnooze_thread', body: { account: 'a1', threadId: 't1' } },
      ]);
      await expect(executeBriefAction('defer_task', { cardId: 'c1' }, () => {})).rejects.toThrow('dueAt');
      await expect(
        executeBriefAction('defer_thread', { account: 'a1', threadId: 't1', until: 5 }, () => {}),
      ).rejects.toThrow('future');
      expect(briefActionHidesItem('defer_task', {})).toBe(true);
      expect(briefActionHidesItem('defer_thread', {})).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('native decodes the weekly kind from the contract', () => {
    expect(BriefEditionKindSchema.parse('weekly')).toBe('weekly');
    expect(MobileContractV1.schemas.BriefEditionKind).toBe(BriefEditionKindSchema);
  });
});

test('the default brief-ready queue sends the weekly title to Convex', async () => {
  const hosted = await import('../lib/hosted/convex');
  const { spyOn } = await import('bun:test');
  const mutation = spyOn(hosted, 'convexMutation').mockImplementation((async (_fn: any, args: any) => ({
    notificationId: null,
    skipped: 'disabled',
    args,
  })) as any);
  try {
    const result = await notifyBriefReady('u1', 'weekly', { _id: 'w', generatedAt: SUNDAY }, TZ);
    expect(result).toEqual({ skipped: 'disabled' });
    expect(mutation.mock.calls[0][1]).toMatchObject({ title: WEEKLY_REVIEW_READY_TITLE, reportId: 'w' });
  } finally {
    mutation.mockRestore();
  }
});
