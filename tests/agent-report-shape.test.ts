import { describe, expect, test } from 'bun:test';
import { toBriefEvent, toBriefTask } from '../lib/mail/agent-report';
import type { DailyReportCalendarItem, DailyReportTaskItem } from '../lib/shared/types';

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
