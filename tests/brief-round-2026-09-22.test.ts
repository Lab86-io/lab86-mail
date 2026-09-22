import { describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { briefNotificationBody } from '../app/api/cron/daily-report/route';
import { api, internal } from '../convex/_generated/api';
import schema from '../convex/schema';
import {
  areaArtifactRevision,
  areaMailForBrief,
  buildAreaArtifactContext,
  composeAreaPulseDocument,
  fallbackAreaSinceLastBrief,
  fallbackAreaWeekAhead,
  renderAreaPulseHtml,
} from '../lib/albatross/area-living-brief';
import { AREA_LETTER_REGION_IDS, briefLetterKind, DAILY_LETTER_REGION_IDS } from '../lib/brief/letter';
import {
  carriedDaysFor,
  carryOverItems,
  findPreviousEdition,
  sinceWindowStart,
} from '../lib/mail/agent-report';
import {
  BUDGET_TASK_LIMIT,
  BUDGET_WAITING_LIMIT,
  carriedAgeLabel,
  composeBudgetBriefDocument,
  tasksForBrief,
  threadActions,
} from '../lib/mail/brief-budget-document';
import { connectedItemReason, connectedItemScore, rankConnectedItems } from '../lib/mail/brief-connected';
import { buildBriefProsePrompt, yesterdayFallback } from '../lib/mail/brief-prose';
import { lintBriefDocument } from '../lib/shared/brief-document';
import type {
  DailyReport,
  DailyReportItem,
  DailyReportMcpItem,
  DailyReportTaskItem,
} from '../lib/shared/types';

const NOW = Date.parse('2026-09-22T11:00:00Z');
const DAY = 86_400_000;
const TZ = 'America/New_York';

function item(threadId: string, extra: Partial<DailyReportItem> = {}): DailyReportItem {
  return {
    account: 'jakob@example.com',
    threadId,
    subject: `Subject ${threadId}`,
    people: ['Maya Chen'],
    whyItMatters: 'Maya asked for notes.',
    unread: false,
    receivedAt: NOW - DAY,
    ...extra,
  };
}

function report(overrides: Partial<DailyReport['sections']> = {}, generatedAt = NOW): DailyReport {
  return {
    _id: 'r-now',
    kind: 'morning',
    generatedAt,
    status: 'ready',
    accounts: ['jakob@example.com'],
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
      calendar: [],
      ...overrides,
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

function task(
  cardId: string,
  dueAt: number | null,
  extra: Partial<DailyReportTaskItem> = {},
): DailyReportTaskItem {
  return {
    cardId,
    boardId: 'b1',
    columnId: 'c1',
    boardTitle: 'Home',
    title: `Task ${cardId}`,
    dueAt,
    completedAt: null,
    scope: 'week',
    ...extra,
  };
}

function mcp(externalId: string, extra: Partial<DailyReportMcpItem> = {}): DailyReportMcpItem {
  return {
    server: 'github',
    externalId,
    kind: 'pull_request',
    title: `PR ${externalId}`,
    url: `https://github.com/x/y/pull/${externalId}`,
    updatedAt: NOW - 2 * 3_600_000,
    ...extra,
  };
}

describe('continuity across editions', () => {
  test('findPreviousEdition skips the report being written and later reports', async () => {
    const list = async () =>
      [
        report({}, NOW + 3_600_000),
        { ...report({}, NOW - DAY), _id: 'r-yesterday' },
        { ...report({}, NOW - 2 * DAY), _id: 'r-older' },
      ] as DailyReport[];
    const previous = await findPreviousEdition('r-now', NOW, list);
    expect(previous?._id).toBe('r-yesterday');
    expect(await findPreviousEdition('r-now', NOW, async () => [])).toBeNull();
    expect(
      await findPreviousEdition('r-now', NOW, async () => {
        throw new Error('down');
      }),
    ).toBeNull();
  });

  test('carryOverItems keeps the first surfaced time and stamps new items with today', () => {
    const previous = {
      ...report(
        {
          answer: [item('t1', { firstSurfacedAt: NOW - 3 * DAY })],
          know: [item('t2')],
        },
        NOW - DAY,
      ),
      _id: 'r-yesterday',
    };
    const next = carryOverItems(
      report({ answer: [item('t1'), item('t3')], waiting: [item('t2')] }),
      previous,
    );
    expect(next.sections.answer?.[0].firstSurfacedAt).toBe(NOW - 3 * DAY);
    expect(next.sections.answer?.[1].firstSurfacedAt).toBe(NOW);
    // t2 had no explicit first time in the previous edition, so it inherits
    // that edition's generatedAt.
    expect(next.sections.waiting?.[0].firstSurfacedAt).toBe(NOW - DAY);
    expect(carriedDaysFor(next.sections.answer![0], NOW)).toBe(3);
    expect(carriedDaysFor(next.sections.answer![1], NOW)).toBe(0);
    expect(carriedAgeLabel(next.sections.answer![0], NOW)).toBe('Day 4');
    expect(carriedAgeLabel(next.sections.answer![1], NOW)).toBe('');
    // Without a previous edition every item is new today.
    const fresh = carryOverItems(report({ answer: [item('t9')] }), null);
    expect(fresh.sections.answer?.[0].firstSurfacedAt).toBe(NOW);
  });

  test('sinceWindowStart covers the gap since the previous edition, bounded to a week', () => {
    expect(sinceWindowStart(null, NOW)).toBe(NOW - DAY);
    expect(sinceWindowStart({ ...report({}, NOW - 2 * DAY) }, NOW)).toBe(NOW - 2 * DAY);
    expect(sinceWindowStart({ ...report({}, NOW - 30 * DAY) }, NOW)).toBe(NOW - 7 * DAY);
  });
});

describe('yesterday prose', () => {
  test('the fallback names the intent, the completions, and the agent actions', () => {
    const text = yesterdayFallback({
      tomorrowIntent: 'I want to finish the deck.',
      since: {
        previousGeneratedAt: NOW - DAY,
        completed: ['Book the venue', 'Send the invoice'],
        agentActions: ['Archived 12 newsletters'],
      },
    });
    expect(text).toBe(
      'You said you wanted to finish the deck. Book the venue and Send the invoice are done. One action was taken for you: Archived 12 newsletters.',
    );
    expect(yesterdayFallback({})).toBe('');
  });

  test('the prompt carries the since block and carried days', () => {
    const prompt = buildBriefProsePrompt({
      firstName: 'Jakob',
      kind: 'morning',
      now: NOW,
      timezone: TZ,
      items: [
        {
          key: 'a:t1',
          lane: 'answer',
          sender: 'Maya',
          subject: 'Venue',
          receivedAt: NOW - DAY,
          carriedDays: 2,
          messages: [],
        },
      ],
      calendar: [],
      tasks: [],
      areas: [],
      since: { previousGeneratedAt: NOW - DAY, completed: ['Book the venue'], agentActions: [] },
    });
    const data = JSON.parse(prompt.slice(prompt.indexOf('{'), prompt.lastIndexOf('}') + 1));
    expect(data.items[0].carriedDays).toBe(2);
    expect(data.since.completed).toEqual(['Book the venue']);
    expect(data.since.previousLetter).toContain('Monday');
  });
});

describe('connected item ranking', () => {
  test('assignment, open state, and recency order the list; closed items drop', () => {
    const items = [
      mcp('1', { state: 'merged', assignedToUser: true, updatedAt: NOW - 100 * DAY }),
      mcp('2', { state: 'open', assignedToUser: true }),
      mcp('3', { state: 'review_requested' }),
      mcp('4', { server: 'granola', kind: 'meeting', state: null, updatedAt: NOW - 30 * DAY }),
      mcp('5', { state: 'closed', updatedAt: NOW - 30 * DAY }),
      mcp('2', { state: 'open', assignedToUser: true }),
    ];
    const ranked = rankConnectedItems(items, NOW);
    expect(ranked.map((row) => row.externalId)).toEqual(['2', '3', '4', '1']);
    expect(connectedItemScore(mcp('5', { state: 'closed', updatedAt: NOW - 30 * DAY }), NOW)).toBeLessThan(1);
    expect(connectedItemReason(mcp('2', { state: 'review_requested', assignedToUser: true }))).toBe(
      'GitHub pull request, review requested, assigned to you',
    );
    expect(
      connectedItemReason(
        mcp('9', { server: 'jira', kind: 'ticket', state: 'In Progress', repository: 'OPS' }),
      ),
    ).toBe('Jira ticket, in progress, OPS');
  });
});

describe('budget document regions', () => {
  test('yesterday, waiting, tasks, and connected regions render in order with their actions', () => {
    const document = composeBudgetBriefDocument({
      report: report({
        answer: [item('t1', { firstSurfacedAt: NOW - 2 * DAY, sender: 'Maya' })],
        today: [item('t2', { dueAt: NOW + 3_600_000 })],
        know: [item('t3')],
        waiting: [
          item('t4', { trackedThreadId: 'tracked-4' }),
          item('t5'),
          item('t6'),
          item('t7'),
          item('t8'),
        ],
        tasks: [
          task('c1', NOW + 2 * DAY),
          task('c2', NOW - DAY),
          task('c3', NOW + 30 * DAY),
          task('c4', null),
          task('c5', NOW + DAY, { completedAt: NOW }),
          task('c6', NOW + 3 * DAY),
          task('c7', NOW + 4 * DAY),
          task('c8', NOW + 5 * DAY),
          task('c9', NOW + 6 * DAY),
        ],
        mcp: [
          mcp('1', { state: 'open', assignedToUser: true }),
          mcp('2', { state: 'closed', updatedAt: NOW - 30 * DAY }),
        ],
      }),
      prose: {
        lede: 'Here is your morning.',
        yesterday: 'You wanted the deck done. It is done.',
        weekAhead: 'Friday is open.',
        lines: { 'jakob@example.com:t4': 'Daniel has the draft.' },
      },
      areas: [{ areaId: 'a1', name: 'Home', line: 'Pick a venue.' }],
      timezone: TZ,
    });
    expect(lintBriefDocument(document)).toEqual([]);
    expect(document.regions.map((region) => region.id)).toEqual([
      'lede',
      'yesterday',
      'answer',
      'today',
      'know',
      'waiting',
      'tasks',
      'connected',
      'week-ahead',
      'areas',
    ]);
    expect(briefLetterKind(document)).toBe('daily');
    expect(
      document.regions.every((region) => (DAILY_LETTER_REGION_IDS as readonly string[]).includes(region.id)),
    ).toBe(true);

    const answer = document.regions[2].tree as any;
    expect(answer.items[0].framing).toEqual({
      lane: 'answer',
      sender: 'Maya',
      age: 'Day 3',
    });
    expect(answer.items[0].actions.map((action: any) => action.action)).toEqual([
      'open_thread',
      'draft_reply',
      'dismiss_thread',
    ]);

    const today = document.regions[3].tree as any;
    expect(today.items[0].actions.map((action: any) => action.action)).toEqual([
      'open_thread',
      'create_task',
      'dismiss_thread',
    ]);
    expect(today.items[0].actions[1].payload).toMatchObject({ title: 'Subject t2', dueAt: NOW + 3_600_000 });

    const know = document.regions[4].tree as any;
    expect(know.items[0].actions.map((action: any) => action.action)).toEqual([
      'open_thread',
      'dismiss_thread',
    ]);

    const waiting = document.regions[5].tree as any;
    expect(waiting.title).toBe('Waiting on');
    expect(waiting.items).toHaveLength(BUDGET_WAITING_LIMIT);
    expect(waiting.items[0].framing).toMatchObject({ lane: 'waiting', reason: 'Daniel has the draft.' });
    expect(waiting.items[1].framing.reason).toBe('Maya asked for notes.');
    expect(waiting.items[0].actions.map((action: any) => action.action)).toEqual([
      'open_thread',
      'resolve_thread',
    ]);
    expect(waiting.items[0].actions[1].payload.trackedThreadId).toBe('tracked-4');

    const tasks = document.regions[6].tree as any;
    expect(tasks.title).toBe('Tasks this week');
    expect(tasks.items).toHaveLength(BUDGET_TASK_LIMIT);
    // Overdue first, then soonest; the month-out, undated, and completed cards stay out.
    expect(tasks.items.map((row: any) => row.ref.id)).toEqual(['c2', 'c1', 'c6', 'c7', 'c8']);
    expect(tasks.items[0].ref.kind).toBe('task');
    expect(tasks.items[0].framing.reason).toBe('Overdue');
    expect(tasks.items[1].framing).toMatchObject({ lane: 'tasks', sender: 'Home' });
    expect(tasks.items[1].framing.reason).toMatch(/^Due (today|tomorrow|[A-Z][a-z]+day)$/);
    expect(tasks.items[0].actions.map((action: any) => [action.action, action.label])).toEqual([
      ['toggle_task', 'Done'],
      ['dismiss_task', 'Not needed'],
    ]);
    expect(tasks.items[0].actions[0].payload).toEqual({ cardId: 'c2', completed: true, title: 'Task c2' });

    const connected = document.regions[7].tree as any;
    expect(connected.title).toBe('Connected tools');
    expect(connected.items).toHaveLength(1);
    expect(connected.items[0].ref).toEqual({ kind: 'mcp', id: '1', label: 'PR 1' });
    expect(connected.items[0].framing.reason).toBe('GitHub pull request, open, assigned to you');
    expect(connected.items[0].actions[0]).toMatchObject({
      action: 'open_url',
      payload: { url: 'https://github.com/x/y/pull/1' },
    });
  });

  test('the new regions are absent when their sections are empty', () => {
    const document = composeBudgetBriefDocument({
      report: report({ know: [item('t3')] }),
      prose: { lede: 'Quiet.', weekAhead: '', lines: {} },
      timezone: TZ,
    });
    expect(document.regions.map((region) => region.id)).toEqual(['lede', 'know']);
    expect(briefLetterKind(document)).toBe('daily');
  });

  test('tasksForBrief and threadActions are pure and bounded', () => {
    expect(tasksForBrief(undefined, NOW)).toEqual([]);
    expect(tasksForBrief([task('c1', NOW + 8 * DAY)], NOW)).toEqual([]);
    expect(threadActions(item('t1'), 'know').map((action) => action.action)).toEqual([
      'open_thread',
      'dismiss_thread',
    ]);
    expect(threadActions(item('t1'), 'today').map((action) => action.action)).toEqual([
      'open_thread',
      'dismiss_thread',
    ]);
    expect(threadActions(item('t1', { receivedAt: 5 }), 'answer')[2].payload).toEqual({
      account: 'jakob@example.com',
      threadId: 't1',
      subject: 'Subject t1',
      receivedAt: 5,
    });
  });
});

describe('area letter additions', () => {
  const home = {
    area: { _id: 'area-1', name: 'Studio' },
    livingBrief: { status: 'ready', pulseUpdatedAt: NOW - DAY, updatedAt: NOW - DAY },
    mail: [
      {
        accountId: 'acc',
        providerThreadId: 'm1',
        subject: 'Old',
        fromAddress: 'a@x.com',
        lastDate: NOW - 3 * DAY,
        linkStatus: 'verified',
      },
      {
        accountId: 'acc',
        providerThreadId: 'm2',
        subject: 'New unread',
        fromAddress: 'b@x.com',
        lastDate: NOW - 3_600_000,
        unread: true,
        linkStatus: 'verified',
      },
      {
        accountId: 'acc',
        providerThreadId: 'm3',
        subject: 'Maybe',
        fromAddress: 'c@x.com',
        lastDate: NOW,
        linkStatus: 'candidate',
      },
    ],
    events: [
      {
        accountId: 'acc',
        providerEventId: 'e1',
        title: 'Dentist',
        startAt: NOW + 2 * DAY,
        endAt: NOW + 2 * DAY + 3_600_000,
      },
      {
        accountId: 'acc',
        providerEventId: 'e2',
        title: 'Far away',
        startAt: NOW + 20 * DAY,
        endAt: NOW + 20 * DAY + 3_600_000,
      },
    ],
    tasks: [
      { cardId: 'c1', title: 'Pay rent', dueAt: NOW + 3 * DAY, updatedAt: NOW - 3_600_000 },
      {
        cardId: 'c2',
        title: 'Done thing',
        dueAt: NOW + DAY,
        completedAt: NOW - DAY,
        updatedAt: NOW - 2 * DAY,
      },
    ],
    plans: [{ intentId: 'w1', title: 'Ship the layer', updatedAt: NOW - 1_800_000 }],
  };

  test('the context carries the week window and the delta since the last brief, outside the revision', () => {
    const context = buildAreaArtifactContext(home as any, NOW);
    expect(context.weekAhead.events.map((event: any) => event.title)).toEqual(['Dentist']);
    expect(context.weekAhead.dueTasks.map((row: any) => row.title)).toEqual(['Pay rent']);
    expect(context.sinceLastBrief).toMatchObject({ newMailCount: 2, movedTaskCount: 1, movedWorkCount: 1 });
    const later = buildAreaArtifactContext(
      { ...home, livingBrief: { ...home.livingBrief, pulseUpdatedAt: NOW - 10 * DAY } } as any,
      NOW,
    );
    expect(later.sinceLastBrief?.newMailCount).toBe(3);
    // A different delta must not force a rewrite by itself.
    expect(areaArtifactRevision(context)).toBe(areaArtifactRevision(later));
    const noBrief = buildAreaArtifactContext({ ...home, livingBrief: null } as any, NOW);
    expect(noBrief.sinceLastBrief).toBeNull();
  });

  test('fallbacks name the days and count the delta', () => {
    const context = buildAreaArtifactContext(home as any, NOW);
    expect(fallbackAreaWeekAhead(context)).toMatch(
      /^[A-Z][a-z]+day: Dentist\. [A-Z][a-z]+day: Pay rent is due\.$/,
    );
    expect(fallbackAreaSinceLastBrief(context)).toBe(
      'Since the last brief: 2 new messages, 1 task moved and 1 Work item changed.',
    );
    expect(fallbackAreaWeekAhead({})).toBe('');
    expect(fallbackAreaSinceLastBrief({})).toBe('');
  });

  test('the document adds week and mail regions and stays a letter', () => {
    const context = buildAreaArtifactContext(home as any, NOW);
    const mail = areaMailForBrief(context);
    expect(mail.map((row) => row.threadId)).toEqual(['m2', 'm1']);
    expect(mail[0].reason).toBe('Unread');
    const pulse = {
      lastChange: 'Maya wrote.',
      nextMove: 'Reply.',
      openQuestion: '',
      prose: 'The studio moves.',
      weekAhead: 'Wednesday: dentist.',
      sinceLastBrief: 'Since the last brief: 2 new messages.',
    };
    const document = composeAreaPulseDocument(context, pulse);
    expect(lintBriefDocument(document)).toEqual([]);
    expect(document.regions.map((region) => region.id)).toEqual([
      'lede',
      'pulse',
      'ask',
      'week',
      'mail',
      'open-work',
    ]);
    expect(
      document.regions.every((region) => (AREA_LETTER_REGION_IDS as readonly string[]).includes(region.id)),
    ).toBe(true);
    expect(briefLetterKind(document)).toBe('area');
    const pulseStack = document.regions[1].tree as any;
    expect(pulseStack.children.map((child: any) => child.text)).toEqual([
      'Last change: Maya wrote.',
      'Next move: Reply.',
      'Since the last brief: 2 new messages.',
    ]);
    const mailRegion = document.regions[4].tree as any;
    expect(mailRegion.items[0].ref).toEqual({
      kind: 'thread',
      id: 'm2',
      account: 'acc',
      label: 'New unread',
    });
    expect(mailRegion.items[0].actions.map((action: any) => action.action)).toEqual([
      'open_thread',
      'draft_reply',
    ]);
    const html = renderAreaPulseHtml('Studio', pulse);
    expect(html).toContain('This week.');
    expect(html).toContain('Wednesday: dentist.');
  });
});

describe('brief notification body', () => {
  test('uses the lede, cut at a sentence end inside the limit', () => {
    expect(briefNotificationBody({ prose: { lede: 'Maya waits on the venue. Friday is open.' } })).toBe(
      'Maya waits on the venue. Friday is open.',
    );
    const long = `${'A sentence that runs on for a while. '.repeat(3)}Then the last one which is far too long to fit inside the limit of one push body.`;
    const body = briefNotificationBody({ prose: { lede: long } });
    expect(body.length).toBeLessThanOrEqual(180);
    expect(body.endsWith('.')).toBe(true);
    expect(briefNotificationBody({ narrative: 'Fallback narrative.' })).toBe('Fallback narrative.');
    expect(briefNotificationBody({})).toBe('');
  });
});

describe('convex: catch-up pass and telemetry', () => {
  const convexModules = {
    '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
    '../convex/dailyReports.ts': () => import('../convex/dailyReports'),
    '../convex/briefEvents.ts': () => import('../convex/briefEvents'),
  };
  const SECRET = 'brief-round-secret';
  async function withSecret<T>(run: () => Promise<T>): Promise<T> {
    const previous = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
    try {
      return await run();
    } finally {
      if (previous === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previous;
    }
  }

  test('dueTargets fires the morning hour always and the catch-up hours only without an edition', async () => {
    const { dueTargets, localDateKey } = await import('../convex/dailyReports');
    // 11:00Z = 07:00 New York, 12:00 London, 04:00 Los Angeles.
    const at = new Date(NOW);
    const targets = [
      { userId: 'ny', timezone: 'America/New_York' },
      { userId: 'london', timezone: 'Europe/London' },
      { userId: 'london-done', timezone: 'Europe/London' },
      { userId: 'la', timezone: 'America/Los_Angeles' },
    ];
    // London is at 12:00, outside the catch-up window. Move the clock so it is 10:00.
    const due = dueTargets(targets, at, (target) => target.userId === 'london-done');
    expect(due.map((row) => `${row.userId}:${row.catchUp}`)).toEqual(['ny:false']);
    const tenLondon = new Date(Date.parse('2026-09-22T09:00:00Z'));
    const later = dueTargets(targets, tenLondon, (target) => target.userId === 'london-done');
    expect(later.map((row) => `${row.userId}:${row.catchUp}`)).toEqual(['london:true']);
    expect(localDateKey('America/New_York', new Date(Date.parse('2026-09-22T03:00:00Z')))).toBe('2026-09-21');
  });

  test('hasMorningEdition reads the newest morning edition in the user zone', async () => {
    await withSecret(async () => {
      const t = convexTest(schema, convexModules);
      const at = Date.parse('2026-09-22T13:00:00Z');
      expect(await t.query(internal.dailyReports.hasMorningEdition, { userId: 'u1', timezone: TZ, at })).toBe(
        false,
      );
      await t.run(async (ctx) => {
        await ctx.db.insert('userDocs', {
          userId: 'u1',
          kind: 'dailyReport',
          key: 'r-yesterday',
          doc: { _id: 'r-yesterday', kind: 'morning', generatedAt: Date.parse('2026-09-21T11:05:00Z') },
          createdAt: at,
          updatedAt: at,
        });
      });
      expect(await t.query(internal.dailyReports.hasMorningEdition, { userId: 'u1', timezone: TZ, at })).toBe(
        false,
      );
      await t.run(async (ctx) => {
        await ctx.db.insert('userDocs', {
          userId: 'u1',
          kind: 'dailyReport',
          key: 'r-today',
          doc: { _id: 'r-today', kind: 'morning', generatedAt: Date.parse('2026-09-22T11:05:00Z') },
          createdAt: at,
          updatedAt: at,
        });
        await ctx.db.insert('userDocs', {
          userId: 'u1',
          kind: 'dailyReport',
          key: 'r-manual',
          doc: { _id: 'r-manual', kind: 'manual', generatedAt: Date.parse('2026-09-22T12:00:00Z') },
          createdAt: at,
          updatedAt: at,
        });
      });
      expect(await t.query(internal.dailyReports.hasMorningEdition, { userId: 'u1', timezone: TZ, at })).toBe(
        true,
      );
      expect(await t.query(internal.dailyReports.hasMorningEdition, { userId: 'u2', timezone: TZ, at })).toBe(
        false,
      );
    });
  });

  test('brief events record and summarize per user', async () => {
    await withSecret(async () => {
      const t = convexTest(schema, convexModules);
      const base = {
        internalSecret: SECRET,
        surface: 'daily' as const,
        regionId: 'answer',
        action: 'draft_reply',
        refKind: 'thread',
        refId: 't1',
        outcome: 'done' as const,
      };
      await t.mutation(api.briefEvents.record, { ...base, userId: 'u1', reportId: 'r1' });
      await t.mutation(api.briefEvents.record, { ...base, userId: 'u1', outcome: 'failed' });
      await t.mutation(api.briefEvents.record, { ...base, userId: 'u2' });
      const summary = await t.query(api.briefEvents.summary, { internalSecret: SECRET, userId: 'u1' });
      expect(summary.total).toBe(2);
      expect(summary.counts).toEqual({
        'daily:answer:draft_reply:done': 1,
        'daily:answer:draft_reply:failed': 1,
      });
      await expect(
        t.mutation(api.briefEvents.record, { ...base, internalSecret: 'wrong', userId: 'u1' }),
      ).rejects.toThrow();
    });
  });
});
