import { describe, expect, test } from 'bun:test';
import './tools/harness';
import { buildDataPrompt, gatherBriefExtras, toBriefEvent, toBriefTask } from '../lib/mail/agent-report';
import type { DailyReport, DailyReportCalendarItem, DailyReportTaskItem } from '../lib/shared/types';
import { withToolContext } from './tools/harness';

describe('toBriefTask', () => {
  test('passes through the richer fields the agent acts on', () => {
    const task: DailyReportTaskItem = {
      cardId: 'card_1',
      boardId: 'b1',
      columnId: 'c1',
      boardTitle: 'Work',
      columnName: 'Today',
      title: 'Ship the brief',
      description: 'with tests',
      dueAt: 1_700_000_000_000,
      priority: 'high',
      labels: ['eng', 'p0'],
      assignees: ['me@example.test'],
      sourceTitle: 'thread',
      sourceUrl: 'https://example.test/t',
      scope: 'week',
    };
    expect(toBriefTask(task)).toEqual({
      cardId: 'card_1',
      boardTitle: 'Work',
      columnName: 'Today',
      title: 'Ship the brief',
      description: 'with tests',
      dueAt: 1_700_000_000_000,
      priority: 'high',
      labels: ['eng', 'p0'],
      assignees: ['me@example.test'],
      completed: false,
      sourceUrl: 'https://example.test/t',
      sourceTitle: 'thread',
    });
  });

  test('defaults optional fields so the agent never sees undefined', () => {
    const task: DailyReportTaskItem = {
      cardId: 'card_2',
      boardId: 'b1',
      columnId: 'c1',
      title: 'Minimal',
      scope: 'week',
    };
    const shaped = toBriefTask(task);
    expect(shaped.description).toBeNull();
    expect(shaped.dueAt).toBeNull();
    expect(shaped.labels).toEqual([]);
    expect(shaped.assignees).toEqual([]);
    expect(shaped.sourceUrl).toBeNull();
    expect(shaped.completed).toBe(false);
  });
});

describe('toBriefEvent', () => {
  test('exposes calendarId (needed for rsvp_event) and the richer fields', () => {
    const event: DailyReportCalendarItem = {
      account: 'me@example.test',
      eventId: 'evt_1',
      calendarId: 'cal_1',
      calendarName: 'Primary',
      title: 'Sync',
      startAt: 1_700_000_000_000,
      endAt: 1_700_003_600_000,
      allDay: false,
      location: 'Room 4',
      description: 'agenda',
      htmlLink: 'https://example.test/e',
      scope: 'week',
    };
    expect(toBriefEvent(event)).toEqual({
      account: 'me@example.test',
      eventId: 'evt_1',
      calendarId: 'cal_1',
      calendarName: 'Primary',
      title: 'Sync',
      startAt: 1_700_000_000_000,
      endAt: 1_700_003_600_000,
      allDay: false,
      location: 'Room 4',
      description: 'agenda',
      htmlLink: 'https://example.test/e',
    });
  });

  test('nulls missing optional fields and defaults allDay', () => {
    const event: DailyReportCalendarItem = {
      account: 'me@example.test',
      eventId: 'evt_2',
      title: 'Bare',
      startAt: 1,
      endAt: 2,
      scope: 'month',
    };
    const shaped = toBriefEvent(event);
    expect(shaped.calendarId).toBeNull();
    expect(shaped.calendarName).toBeNull();
    expect(shaped.location).toBeNull();
    expect(shaped.description).toBeNull();
    expect(shaped.htmlLink).toBeNull();
    expect(shaped.allDay).toBe(false);
  });
});

describe('daily brief service metadata', () => {
  test('gatherBriefExtras falls back to mail and includes calendar/task sources', async () => {
    const empty = reportFixture();
    await expect(gatherBriefExtras(empty)).resolves.toMatchObject({
      digests: [],
      voiceSamples: [],
      services: ['mail'],
    });

    const withSources = reportFixture({
      sections: {
        ...empty.sections,
        calendar: [
          {
            account: 'me@example.test',
            eventId: 'evt_3',
            title: 'Review',
            startAt: 1,
            endAt: 2,
            scope: 'week',
          },
        ],
        tasks: [
          {
            cardId: 'card_3',
            boardId: 'board',
            columnId: 'column',
            title: 'Prep agenda',
            scope: 'week',
          },
        ],
      },
    });
    const extras = await gatherBriefExtras(withSources);
    expect(extras.services).toEqual(['calendar', 'tasks']);
  });

  test('buildDataPrompt serializes logo-bearing service definitions', async () => {
    const report = reportFixture({
      services: ['gmail'],
      sections: {
        ...reportFixture().sections,
        mcp: [
          {
            server: 'github',
            kind: 'pull_request',
            title: 'Review auth fix',
          },
        ],
      },
    });

    const prompt = await withToolContext(() =>
      Promise.resolve(
        buildDataPrompt(report, {
          digests: [],
          voiceSamples: ['Sounds good, thanks for moving this forward.'],
          services: ['slack'],
        }),
      ),
    );
    const json = prompt.match(/```json\n([\s\S]*?)\n```/)?.[1] || '{}';
    const data = JSON.parse(json);
    expect(data.services.map((service: any) => service.id)).toEqual(['gmail', 'slack', 'github']);
    expect(data.services.map((service: any) => service.label)).toEqual(['Gmail', 'Slack', 'GitHub']);
    expect(data.services.every((service: any) => service.logoSvg.includes('footer-logo'))).toBe(true);
  });
});

function reportFixture(overrides: Partial<DailyReport> = {}): DailyReport {
  return {
    _id: 'report_agent_shape',
    kind: 'manual',
    generatedAt: Date.parse('2026-06-10T12:00:00.000Z'),
    status: 'ready',
    accounts: [],
    title: 'Brief',
    narrative: 'Brief narrative.',
    sections: {
      replyOwed: [],
      followUpOwed: [],
      newPeople: [],
      timeSensitive: [],
      tracked: [],
      fyi: [],
      bulkTail: [],
      tasks: [],
      calendar: [],
      mcp: [],
    },
    stats: {},
    ...overrides,
  };
}
