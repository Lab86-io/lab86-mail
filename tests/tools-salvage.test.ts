import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import * as salvage from '../lib/tools/salvage';
import { runTool } from './tools/harness';

// salvage_context (issue #86/#17): the tool must assemble one compact
// rest-of-today pack from calendar, boards, intents, and projects, with the
// "today" window computed on the user's wall clock.

const apiMock = {
  calendarData: { listEvents: 'calendarData.listEvents' },
  boards: { listDueCards: 'boards.listDueCards' },
  albatrossIntents: { listIntents: 'albatrossIntents.listIntents' },
  albatrossWork: { listProjects: 'albatrossWork.listProjects' },
};

// 2026-07-03 15:00:00 America/New_York (19:00Z).
const NOW_MS = Date.parse('2026-07-03T19:00:00.000Z');

const queryCalls: Array<{ fn: string; args: any }> = [];

function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    providerEventId: 'evt_1',
    accountId: 'acct_1',
    providerCalendarId: 'cal_1',
    title: 'Dentist',
    startAt: NOW_MS + 3_600_000,
    endAt: NOW_MS + 5_400_000,
    allDay: false,
    location: 'Main St',
    busy: true,
    readOnly: false,
    status: 'confirmed',
    ...overrides,
  };
}

let fixtures: {
  events: any[];
  cards: any[];
  intents: any[];
  projects: any[];
};

async function convexQueryMock(fn: string, args: any) {
  queryCalls.push({ fn, args });
  if (fn === apiMock.calendarData.listEvents) return fixtures.events;
  if (fn === apiMock.boards.listDueCards) return fixtures.cards;
  if (fn === apiMock.albatrossIntents.listIntents) return fixtures.intents;
  if (fn === apiMock.albatrossWork.listProjects) return fixtures.projects;
  return null;
}

beforeEach(() => {
  queryCalls.length = 0;
  fixtures = {
    events: [eventRow(), eventRow({ providerEventId: 'evt_cancelled', status: 'cancelled' })],
    cards: [
      // Overdue open card — must surface with overdue: true.
      { cardId: 'card_overdue', boardId: 'board_1', title: 'Renew passport', dueAt: NOW_MS - 86_400_000 },
      // Due later today, open.
      {
        cardId: 'card_today',
        boardId: 'board_1',
        title: 'Send invoice',
        priority: 'high',
        dueAt: NOW_MS + 7_200_000,
      },
      // Already completed — must be filtered out.
      { cardId: 'card_done', boardId: 'board_1', title: 'Done thing', dueAt: NOW_MS, completedAt: NOW_MS },
    ],
    intents: [
      { _id: 'intent_ready', title: 'Book DMV slot', status: 'ready', priority: 1, areaId: 'area_life' },
      {
        _id: 'intent_questions',
        rawText: 'figure out the thing with the garage door',
        status: 'needs_answers',
      },
      { _id: 'intent_planning', title: 'Plan trip', status: 'planning' },
      { _id: 'intent_applied', title: 'Already applied', status: 'applied' },
      { _id: 'intent_done', title: 'Old done intent', status: 'done' },
    ],
    projects: [
      {
        _id: 'project_1',
        title: 'Move house',
        outcome: 'x'.repeat(500),
        status: 'active',
        areaId: 'area_home',
      },
    ],
  };
  salvage.__setSalvageToolDepsForTest({
    api: apiMock as any,
    convexQuery: convexQueryMock as any,
    now: () => NOW_MS,
  });
});

afterAll(() => {
  salvage.__setSalvageToolDepsForTest();
});

describe('endOfTodayMs', () => {
  test('computes end of day on the user wall clock, not UTC', () => {
    // 15:00 in New York → end of the NY day is 23:59:59-04:00 = 03:59:59Z next day.
    const end = salvage.endOfTodayMs(NOW_MS, 'America/New_York');
    expect(new Date(end).toISOString()).toBe('2026-07-04T03:59:59.000Z');
  });

  test('falls back to UTC without a timezone', () => {
    const end = salvage.endOfTodayMs(NOW_MS, undefined);
    expect(new Date(end).toISOString()).toBe('2026-07-03T23:59:59.000Z');
  });
});

describe('salvage_context', () => {
  test('assembles the rest-of-today pack from all four sources', async () => {
    const result = await runTool(salvage.salvageContext.handler, {});

    expect(result.now).toBe(new Date(NOW_MS).toISOString());
    expect(result.timezone).toBe('America/New_York');

    // Calendar window: from now to end of today in the user's timezone.
    const eventsCall = queryCalls.find((call) => call.fn === apiMock.calendarData.listEvents);
    expect(eventsCall?.args.startAt).toBe(NOW_MS);
    expect(new Date(eventsCall?.args.endAt).toISOString()).toBe('2026-07-04T03:59:59.000Z');

    // Cancelled events drop; the survivor is compact with ISO times.
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      eventId: 'evt_1',
      title: 'Dentist',
      startIso: new Date(NOW_MS + 3_600_000).toISOString(),
    });

    // Tasks: completed filtered out, overdue flagged, sorted by due date.
    expect(result.tasks.map((task: any) => task.cardId)).toEqual(['card_overdue', 'card_today']);
    expect(result.tasks[0].overdue).toBe(true);
    expect(result.tasks[1]).toMatchObject({ overdue: false, priority: 'high' });
    // The due-card window reaches back for overdue and stops at end of today.
    const cardsCall = queryCalls.find((call) => call.fn === apiMock.boards.listDueCards);
    expect(cardsCall?.args.startAt).toBeLessThan(NOW_MS);
    expect(cardsCall?.args.endAt).toBeGreaterThan(NOW_MS);

    // Intents: only ready/needs_answers/planning survive; untitled intents
    // fall back to their raw dump.
    expect(result.intents.map((intent: any) => intent.intentId)).toEqual([
      'intent_ready',
      'intent_questions',
      'intent_planning',
    ]);
    expect(result.intents[1].title).toContain('garage door');

    // Projects: active only, outcome bounded.
    const projectsCall = queryCalls.find((call) => call.fn === apiMock.albatrossWork.listProjects);
    expect(projectsCall?.args.status).toBe('active');
    expect(result.projects[0].projectId).toBe('project_1');
    expect(result.projects[0].outcome?.length).toBeLessThanOrEqual(300);
  });

  test('explicit timezone argument overrides the requesting user timezone', async () => {
    const result = await runTool(salvage.salvageContext.handler, { timezone: 'UTC' });
    expect(result.timezone).toBe('UTC');
    const eventsCall = queryCalls.find((call) => call.fn === apiMock.calendarData.listEvents);
    expect(new Date(eventsCall?.args.endAt).toISOString()).toBe('2026-07-03T23:59:59.000Z');
  });

  test('tolerates empty sources and legacy cards without dueAt/priority/area', async () => {
    fixtures = {
      events: [],
      cards: [{ cardId: 'card_legacy', boardId: 'board_1', title: 'Ancient card' }],
      intents: [],
      projects: [],
    };
    const result = await runTool(salvage.salvageContext.handler, {});
    expect(result.events).toEqual([]);
    expect(result.intents).toEqual([]);
    expect(result.projects).toEqual([]);
    expect(result.tasks[0]).toMatchObject({ cardId: 'card_legacy', overdue: false });
    expect(result.tasks[0].dueIso).toBeUndefined();
  });

  test('requires an authenticated user', async () => {
    await expect(runTool(salvage.salvageContext.handler, {}, { userId: null })).rejects.toThrow(
      /Not authenticated/,
    );
  });
});
