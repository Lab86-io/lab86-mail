import { briefWeekDays, localDayKey, localTimeLabel } from '../mail/brief-prose';
import {
  type BriefDocumentV2,
  type BriefNode,
  type BriefRegion,
  parseBriefDocument,
} from '../shared/brief-document';
import { normalizeBriefTimezone } from '../shared/brief-edition';
import { parseIsoInTimezone } from '../shared/timezones';
import type {
  DailyReport,
  DailyReportCalendarItem,
  DailyReportItem,
  DailyReportTaskItem,
} from '../shared/types';
import { WEEKLY_REVIEW_LETTER_TITLE } from './letter';

// The weekly review (FEATURES item 9): an edition of kind `weekly` on Sunday
// at the delivery hour. Five regions, all deterministic:
//
//   lede        hero { text role:lede }       counts of the week
//   done        entity_list                   work and tasks finished this week
//   open        entity_list                   replies and actions owed, tasks due by the week end
//   waiting     entity_list                   threads the user waits on
//   next-week   entity_list                   the next 7 days of calendar, then tasks due in them
//
// Open items carry Defer and Drop. Defer moves a task due date or snoozes a
// thread to next Monday 09:00; Drop takes the item out of the briefs
// (dismiss_task, dismiss_thread). Both have Undo.

export const WEEKLY_REVIEW_TITLE = WEEKLY_REVIEW_LETTER_TITLE;
export const WEEKLY_LIST_LIMIT = 8;
export const WEEKLY_REGION_TITLES = {
  done: 'Done this week',
  open: 'Still open',
  waiting: 'Waiting on',
  'next-week': 'Next week',
} as const;

const WEEK_MS = 7 * 86_400_000;

export interface WeeklyDoneItem {
  kind: 'work' | 'task';
  id: string;
  title: string;
  completedAt: number;
  areaId?: string;
}

export interface WeeklyReviewSection {
  weekStart: number;
  /** Next Monday 09:00 in the user's zone: where Defer moves an item. */
  deferUntil: number;
  done: WeeklyDoneItem[];
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

/** Next Monday 09:00 local after `now`. */
export function nextMondayMorning(now: number, timezone: string): number {
  const zone = normalizeBriefTimezone(timezone);
  const monday = briefWeekDays(now, zone, 8).find((day) => day.index > 0 && day.weekday === 'Monday');
  const key = monday?.dayKey ?? localDayKey(now + WEEK_MS, zone);
  try {
    return parseIsoInTimezone(`${key}T09:00:00`, zone, 'weekly defer');
  } catch {
    return now + WEEK_MS;
  }
}

/** Where Defer moves an item: next Monday, or a week after a later due date. */
export function deferTarget(dueAt: number | null | undefined, deferUntil: number): number {
  return typeof dueAt === 'number' && dueAt >= deferUntil ? dueAt + WEEK_MS : deferUntil;
}

function threadRef(item: DailyReportItem) {
  return {
    kind: 'thread' as const,
    id: item.threadId,
    account: item.account,
    label: item.subject || '(no subject)',
  };
}

function threadPayload(item: DailyReportItem) {
  return {
    account: item.account,
    threadId: item.threadId,
    subject: item.subject || '(no subject)',
    ...(typeof item.receivedAt === 'number' ? { receivedAt: item.receivedAt } : {}),
  };
}

function openThreadItem(item: DailyReportItem, deferUntil: number) {
  const payload = threadPayload(item);
  return {
    ref: threadRef(item),
    framing: {
      lane: 'open',
      ...(item.line || item.whyItMatters ? { reason: item.line || item.whyItMatters } : {}),
      ...(item.sender ? { sender: item.sender } : {}),
    },
    actions: [
      { action: 'open_thread', label: 'Open', payload, style: 'quiet' as const },
      {
        action: 'defer_thread',
        label: 'Defer',
        payload: { ...payload, until: deferUntil },
        style: 'secondary' as const,
      },
      { action: 'dismiss_thread', label: 'Drop', payload, style: 'quiet' as const },
    ],
  };
}

function waitingItem(item: DailyReportItem) {
  const payload = threadPayload(item);
  return {
    ref: threadRef(item),
    framing: {
      lane: 'waiting',
      ...(item.line || item.whyItMatters ? { reason: item.line || item.whyItMatters } : {}),
      ...(item.sender ? { sender: item.sender } : {}),
    },
    actions: [
      { action: 'open_thread', label: 'Open', payload, style: 'quiet' as const },
      {
        action: 'resolve_thread',
        label: 'Done',
        payload: { ...payload, ...(item.trackedThreadId ? { trackedThreadId: item.trackedThreadId } : {}) },
        style: 'quiet' as const,
      },
    ],
  };
}

function dueLabel(dueAt: number | null | undefined, now: number, timezone: string) {
  if (typeof dueAt !== 'number') return 'No due date';
  if (dueAt < now) return `Overdue since ${localDayKey(dueAt, timezone)}`;
  const day = briefWeekDays(now, timezone, 8).find((entry) => entry.dayKey === localDayKey(dueAt, timezone));
  if (!day) return `Due ${localDayKey(dueAt, timezone)}`;
  return day.isToday ? 'Due today' : day.isTomorrow ? 'Due tomorrow' : `Due ${day.weekday}`;
}

function taskItem(
  task: DailyReportTaskItem,
  lane: string,
  now: number,
  deferUntil: number,
  timezone: string,
) {
  return {
    ref: { kind: 'task' as const, id: task.cardId, label: task.title },
    framing: {
      lane,
      reason: dueLabel(task.dueAt, now, timezone),
      ...(task.boardTitle ? { sender: task.boardTitle } : {}),
    },
    actions: [
      {
        action: 'toggle_task',
        label: 'Done',
        payload: { cardId: task.cardId, completed: true, title: task.title },
        style: 'secondary' as const,
      },
      {
        action: 'defer_task',
        label: 'Defer',
        payload: {
          cardId: task.cardId,
          title: task.title,
          dueAt: deferTarget(task.dueAt, deferUntil),
          ...(typeof task.dueAt === 'number' ? { previousDueAt: task.dueAt } : {}),
        },
        style: 'quiet' as const,
      },
      {
        action: 'dismiss_task',
        label: 'Drop',
        payload: { cardId: task.cardId, title: task.title },
        style: 'quiet' as const,
      },
    ],
  };
}

function eventItem(event: DailyReportCalendarItem, timezone: string) {
  const day = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(
    new Date(event.startAt),
  );
  const when = event.allDay ? `${day}, all day` : `${day} ${localTimeLabel(event.startAt, timezone)}`;
  return {
    ref: { kind: 'event' as const, id: event.eventId, account: event.account, label: event.title },
    framing: { lane: 'next-week', reason: event.location ? `${when}, ${event.location}` : when },
    actions: [
      {
        action: 'open_event',
        label: 'Open',
        payload: { account: event.account, eventId: event.eventId },
        style: 'quiet' as const,
      },
    ],
  };
}

function doneItem(item: WeeklyDoneItem, timezone: string) {
  const when = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long' }).format(
    new Date(item.completedAt),
  );
  return {
    ref: { kind: item.kind, id: item.id, label: item.title },
    framing: { lane: 'done', reason: `Finished ${when}` },
    actions:
      item.kind === 'work'
        ? [
            {
              action: 'open_work',
              label: 'Open',
              payload: { workId: item.id, ...(item.areaId ? { areaId: item.areaId } : {}) },
              style: 'quiet' as const,
            },
          ]
        : [],
  };
}

function list(id: keyof typeof WEEKLY_REGION_TITLES, summary: string, items: unknown[]): BriefRegion | null {
  if (!items.length) return null;
  return {
    id,
    summary,
    tree: {
      kind: 'entity_list',
      emphasis: id === 'open' ? 'primary' : 'standard',
      tone: 'neutral',
      title: WEEKLY_REGION_TITLES[id],
      variant: 'rows',
      items,
    } as BriefNode,
  };
}

/** The open tasks due by the end of this week, and those due in the next one. */
export function weeklyTasks(tasks: DailyReportTaskItem[] | undefined, now: number, timezone: string) {
  const days = briefWeekDays(now, timezone, 8);
  const lastKey = days[days.length - 1].dayKey;
  const open = (tasks ?? []).filter((task) => !task.completedAt);
  // "By the week end": overdue, due today, or due before next Monday.
  const monday = days.find((day) => day.index > 0 && day.weekday === 'Monday')?.dayKey ?? lastKey;
  const dueNow = open.filter(
    (task) => typeof task.dueAt === 'number' && localDayKey(task.dueAt, timezone) < monday,
  );
  const dueNext = open.filter((task) => {
    if (typeof task.dueAt !== 'number') return false;
    const key = localDayKey(task.dueAt, timezone);
    return key >= monday && key <= lastKey;
  });
  const byDue = (a: DailyReportTaskItem, b: DailyReportTaskItem) => (a.dueAt ?? 0) - (b.dueAt ?? 0);
  return { dueNow: dueNow.sort(byDue), dueNext: dueNext.sort(byDue) };
}

export function weeklyLede(counts: {
  done: number;
  open: number;
  waiting: number;
  events: number;
  due: number;
}) {
  const parts = [
    counts.done
      ? `This week you finished ${plural(counts.done, 'thing', 'things')}.`
      : 'Nothing was marked finished this week.',
    counts.open
      ? `${plural(counts.open, 'item is', 'items are')} still open${
          counts.waiting ? `, and you are waiting on ${plural(counts.waiting, 'reply', 'replies')}` : ''
        }.`
      : counts.waiting
        ? `Nothing is open on your side, and you are waiting on ${plural(counts.waiting, 'reply', 'replies')}.`
        : 'Nothing is open on your side.',
    counts.events || counts.due
      ? `Next week has ${plural(counts.events, 'event', 'events')} and ${plural(counts.due, 'task', 'tasks')} due.`
      : 'Next week is clear so far.',
  ];
  return `${parts.join(' ')} Defer or drop what will not happen, and the rest is your plan.`;
}

/**
 * The weekly review document from a stored edition. The live read runs this
 * again after it drops handled items, so the page and the sections agree.
 */
export function composeWeeklyReviewDocument(
  report: Pick<DailyReport, 'generatedAt' | 'sections'>,
  timezone?: string | null,
): BriefDocumentV2 {
  const zone = normalizeBriefTimezone(timezone || undefined);
  const now = report.generatedAt || Date.now();
  const sections = report.sections;
  const weekly = sections.weekly;
  const deferUntil = weekly?.deferUntil ?? nextMondayMorning(now, zone);
  const openThreads = [...(sections.answer ?? []), ...(sections.today ?? []), ...(sections.know ?? [])].slice(
    0,
    WEEKLY_LIST_LIMIT,
  );
  const tasks = weeklyTasks(sections.tasks, now, zone);
  const openTasks = tasks.dueNow.slice(0, Math.max(0, WEEKLY_LIST_LIMIT - openThreads.length));
  const waiting = (sections.waiting ?? []).slice(0, WEEKLY_LIST_LIMIT);
  const events = (sections.calendar ?? [])
    .filter((event) => event.startAt >= now && event.startAt < now + WEEK_MS)
    .sort((a, b) => a.startAt - b.startAt)
    .slice(0, WEEKLY_LIST_LIMIT);
  const nextTasks = tasks.dueNext.slice(0, WEEKLY_LIST_LIMIT);
  const done = (weekly?.done ?? []).slice(0, WEEKLY_LIST_LIMIT);
  // The counts are the live ones, so a handled item also leaves the lede.
  const lede = weeklyLede({
    done: done.length,
    open: openThreads.length + openTasks.length,
    waiting: waiting.length,
    events: events.length,
    due: nextTasks.length,
  });
  const regions = [
    {
      id: 'lede',
      summary: lede,
      tree: {
        kind: 'hero',
        emphasis: 'primary',
        tone: 'neutral',
        surface: 'plain',
        children: [{ kind: 'text', emphasis: 'primary', tone: 'neutral', role: 'lede', text: lede }],
      },
    } as BriefRegion,
    list(
      'done',
      `${plural(done.length, 'item', 'items')} finished this week.`,
      done.map((item) => doneItem(item, zone)),
    ),
    list('open', `${plural(openThreads.length + openTasks.length, 'item', 'items')} still open.`, [
      ...openThreads.map((item) => openThreadItem(item, deferUntil)),
      ...openTasks.map((task) => taskItem(task, 'open', now, deferUntil, zone)),
    ]),
    list(
      'waiting',
      `Waiting on ${plural(waiting.length, 'reply', 'replies')}.`,
      waiting.map((item) => waitingItem(item)),
    ),
    list(
      'next-week',
      `Next week: ${plural(events.length, 'event', 'events')}, ${plural(nextTasks.length, 'task', 'tasks')} due.`,
      [
        ...events.map((event) => eventItem(event, zone)),
        ...nextTasks.map((task) => taskItem(task, 'next-week', now, deferUntil, zone)),
      ],
    ),
  ].filter((region): region is BriefRegion => Boolean(region));
  return parseBriefDocument({
    version: 2,
    title: WEEKLY_REVIEW_TITLE,
    summary: lede,
    generatedAt: now,
    timezone: zone,
    regions,
  });
}
