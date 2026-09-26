import {
  type BriefDocumentV2,
  type BriefNode,
  type BriefRegion,
  parseBriefDocument,
} from '../shared/brief-document';
import { dailyBriefEditionTitleAt, normalizeBriefTimezone } from '../shared/brief-edition';
import type {
  DailyReport,
  DailyReportCalendarItem,
  DailyReportItem,
  DailyReportMcpItem,
  DailyReportTaskItem,
} from '../shared/types';
import { connectedItemReason, rankConnectedItems } from './brief-connected';
import { briefWeekDays, eventsByDay, localDayKey, localTimeLabel } from './brief-prose';
import type { BriefLane } from './brief-score';

// The deterministic composer of the budget brief (2026-09-03). The node
// layout is fixed; only the prose inside it comes from the model.
//
//   regions[0] "lede"        hero { text role:lede }
//   regions[n] "yesterday"   text role:body                             when prose
//   regions[n] "answer"      entity_list (thread refs, lane answer)     when items
//   regions[n] "today"       entity_list (event refs, then thread refs) when items or events
//   regions[n] "know"        entity_list (thread refs, lane know)       when items
//   regions[n] "waiting"     entity_list (thread refs)                  when items, max 4
//   regions[n] "tasks"       entity_list (task refs due in 7 days)      when items, max 5
//   regions[n] "connected"   entity_list (mcp refs, ranked)             when items, max 4
//   regions[n] "week-ahead"  text role:body
//   regions[n] "areas"       entity_list variant:compact (area refs)    when areas, max 3
//
// A light (weekend) edition keeps lede, yesterday, answer, today, and
// week-ahead only (lib/brief/schedule.ts).
//
// Nothing else. Every entity item carries the real ref, `framing.lane`,
// `framing.reason` (the model's one line, may be absent), `framing.sender`,
// `framing.age` when carried over, and its actions: open first, then the
// review or immediate actions the clients already know (brief round
// 2026-09-22).

export const BUDGET_TODAY_EVENT_LIMIT = 4;
export const BUDGET_AREA_LIMIT = 3;
export const BUDGET_WAITING_LIMIT = 4;
export const BUDGET_TASK_LIMIT = 5;
export const BUDGET_TASK_WINDOW_DAYS = 7;

export const BRIEF_REGION_TITLES = {
  waiting: 'Waiting on',
  tasks: 'Tasks this week',
  connected: 'Connected tools',
} as const;

export const BRIEF_LANE_TITLES: Record<BriefLane, string> = {
  answer: 'Answer',
  today: 'Today',
  know: 'Know',
};

export interface BudgetAreaLine {
  areaId: string;
  name: string;
  line: string;
}

export interface BudgetBriefDocumentInput {
  report: Pick<DailyReport, 'generatedAt' | 'sections' | 'narrative'> & Pick<Partial<DailyReport>, 'light'>;
  prose: { lede: string; weekAhead: string; lines: Record<string, string>; yesterday?: string };
  areas?: BudgetAreaLine[];
  timezone?: string | null;
}

function threadKey(item: Pick<DailyReportItem, 'account' | 'threadId'>) {
  return `${item.account}:${item.threadId}`;
}

// "Day 3" when the thread was in an earlier edition. Empty on its first day.
export function carriedAgeLabel(item: Pick<DailyReportItem, 'firstSurfacedAt'>, generatedAt: number): string {
  const first = item.firstSurfacedAt;
  if (typeof first !== 'number' || !Number.isFinite(first) || first >= generatedAt) return '';
  const days = Math.floor((generatedAt - first) / 86_400_000);
  return days >= 1 ? `Day ${days + 1}` : '';
}

type ThreadRegion = BriefLane | 'waiting';

interface ItemAction {
  action: string;
  label: string;
  payload: Record<string, unknown>;
  style: 'primary' | 'secondary' | 'danger' | 'quiet';
}

function threadPayload(item: DailyReportItem) {
  return {
    account: item.account,
    threadId: item.threadId,
    subject: item.subject || '(no subject)',
    ...(typeof item.receivedAt === 'number' ? { receivedAt: item.receivedAt } : {}),
  };
}

// The actions for one thread row. Open comes first; clients treat the first
// known action as the row tap. The rest are the review and immediate actions
// both clients already run.
export function threadActions(item: DailyReportItem, region: ThreadRegion): ItemAction[] {
  const payload = threadPayload(item);
  const open: ItemAction = { action: 'open_thread', label: 'Open', payload, style: 'quiet' };
  const dismiss: ItemAction = { action: 'dismiss_thread', label: 'Not needed', payload, style: 'quiet' };
  if (region === 'answer') {
    return [open, { action: 'draft_reply', label: 'Reply', payload, style: 'secondary' }, dismiss];
  }
  if (region === 'today') {
    const actions: ItemAction[] = [open];
    if (typeof item.dueAt === 'number') {
      actions.push({
        action: 'create_task',
        label: 'Add task',
        payload: { ...payload, title: item.subject || 'Follow up', dueAt: item.dueAt },
        style: 'secondary',
      });
    }
    actions.push(dismiss);
    return actions;
  }
  if (region === 'waiting') {
    return [
      open,
      {
        action: 'resolve_thread',
        label: 'Done',
        payload: { ...payload, ...(item.trackedThreadId ? { trackedThreadId: item.trackedThreadId } : {}) },
        style: 'quiet',
      },
    ];
  }
  return [open, dismiss];
}

function laneItem(item: DailyReportItem, lane: ThreadRegion, line: string | undefined, generatedAt: number) {
  const age = carriedAgeLabel(item, generatedAt);
  return {
    ref: {
      kind: 'thread' as const,
      id: item.threadId,
      account: item.account,
      label: item.subject || '(no subject)',
    },
    framing: {
      lane,
      ...(line ? { reason: line } : {}),
      ...(item.sender ? { sender: item.sender } : {}),
      ...(age ? { age } : {}),
    },
    actions: threadActions(item, lane),
  };
}

function dueLabel(dueAt: number, generatedAt: number, timezone: string): string {
  const days = briefWeekDays(generatedAt, timezone, BUDGET_TASK_WINDOW_DAYS);
  const key = localDayKey(dueAt, timezone);
  const day = days.find((entry) => entry.dayKey === key);
  if (!day) return key < days[0].dayKey ? 'Overdue' : `Due ${localDayKey(dueAt, timezone)}`;
  if (day.isToday) return 'Due today';
  if (day.isTomorrow) return 'Due tomorrow';
  return `Due ${day.weekday}`;
}

// Open cards due on or before the last day of the local seven-day table,
// soonest first, overdue included. The bound is a local calendar day, the
// same one dueLabel reads, so no task falls between the filter and the label.
export function tasksForBrief(
  tasks: DailyReportTaskItem[] | undefined,
  generatedAt: number,
  limit = BUDGET_TASK_LIMIT,
  timezone = 'UTC',
): DailyReportTaskItem[] {
  const days = briefWeekDays(generatedAt, timezone, BUDGET_TASK_WINDOW_DAYS);
  const lastDayKey = days[days.length - 1].dayKey;
  return (tasks ?? [])
    .filter(
      (task) =>
        !task.completedAt &&
        typeof task.dueAt === 'number' &&
        localDayKey(task.dueAt, timezone) <= lastDayKey,
    )
    .sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0) || a.title.localeCompare(b.title))
    .slice(0, limit);
}

function taskItem(task: DailyReportTaskItem, generatedAt: number, timezone: string) {
  return {
    ref: { kind: 'task' as const, id: task.cardId, label: task.title },
    framing: {
      lane: 'tasks',
      reason: typeof task.dueAt === 'number' ? dueLabel(task.dueAt, generatedAt, timezone) : 'No due date',
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
        action: 'dismiss_task',
        label: 'Not needed',
        payload: { cardId: task.cardId, title: task.title },
        style: 'quiet' as const,
      },
    ],
  };
}

function connectedItem(item: DailyReportMcpItem) {
  return {
    ref: {
      kind: 'mcp' as const,
      id: `${item.server}:${item.externalId || item.url || item.title}`,
      label: item.title,
    },
    framing: {
      lane: 'connected',
      reason: connectedItemReason(item),
      ...(item.author ? { sender: item.author } : {}),
    },
    actions: item.url
      ? [{ action: 'open_url', label: 'Open', payload: { url: item.url }, style: 'quiet' as const }]
      : [],
  };
}

function eventItem(event: DailyReportCalendarItem, timezone: string) {
  const when = event.allDay
    ? 'All day'
    : `${localTimeLabel(event.startAt, timezone)} to ${localTimeLabel(event.endAt, timezone)}`;
  return {
    ref: { kind: 'event' as const, id: event.eventId, account: event.account, label: event.title },
    framing: {
      lane: 'today' as const,
      reason: event.location ? `${when}, ${event.location}` : when,
    },
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

function laneSummary(lane: BriefLane, items: DailyReportItem[], eventCount: number): string {
  const names = items
    .map((item) => item.sender || item.subject)
    .filter(Boolean)
    .slice(0, 4);
  const parts: string[] = [];
  if (eventCount) parts.push(`${eventCount} ${eventCount === 1 ? 'event' : 'events'}`);
  if (items.length) {
    const noun =
      lane === 'answer'
        ? items.length === 1
          ? 'reply owed'
          : 'replies owed'
        : lane === 'today'
          ? items.length === 1
            ? 'deadline'
            : 'deadlines'
          : items.length === 1
            ? 'thread'
            : 'threads';
    parts.push(`${items.length} ${noun}${names.length ? `: ${names.join(', ')}` : ''}`);
  }
  return `${BRIEF_LANE_TITLES[lane]}: ${parts.join('; ')}.`;
}

export function composeBudgetBriefDocument(input: BudgetBriefDocumentInput): BriefDocumentV2 {
  const timezone = normalizeBriefTimezone(input.timezone || undefined);
  const generatedAt = input.report.generatedAt || Date.now();
  const sections = input.report.sections;
  const lede = input.prose.lede.trim() || input.report.narrative || 'Your brief is ready.';
  const weekAhead = input.prose.weekAhead.trim();
  const yesterday = (input.prose.yesterday || '').trim();
  const light = input.report.light === true;
  const regions: BriefRegion[] = [];

  regions.push({
    id: 'lede',
    summary: lede,
    tree: {
      kind: 'hero',
      emphasis: 'primary',
      tone: 'neutral',
      surface: 'plain',
      children: [{ kind: 'text', emphasis: 'primary', tone: 'neutral', role: 'lede', text: lede }],
    },
  });

  if (yesterday) {
    regions.push({
      id: 'yesterday',
      summary: yesterday,
      tree: { kind: 'text', emphasis: 'standard', tone: 'neutral', role: 'body', text: yesterday },
    });
  }

  const days = briefWeekDays(generatedAt, timezone, 1);
  const todayEvents = (eventsByDay(sections.calendar ?? [], days, timezone).get(days[0].dayKey) || []).slice(
    0,
    BUDGET_TODAY_EVENT_LIMIT,
  );

  for (const lane of light ? (['answer', 'today'] as const) : (['answer', 'today', 'know'] as const)) {
    const items = sections[lane] ?? [];
    const events = lane === 'today' ? todayEvents : [];
    if (!items.length && !events.length) continue;
    const children = [
      ...events.map((event) => eventItem(event, timezone)),
      ...items.map((item) => laneItem(item, lane, input.prose.lines[threadKey(item)], generatedAt)),
    ];
    regions.push({
      id: lane,
      summary: laneSummary(lane, items, events.length),
      tree: {
        kind: 'entity_list',
        emphasis: lane === 'answer' ? 'primary' : 'standard',
        tone: 'neutral',
        title: BRIEF_LANE_TITLES[lane],
        variant: 'rows',
        items: children,
      } as BriefNode,
    });
  }

  const waiting = light ? [] : (sections.waiting ?? []).slice(0, BUDGET_WAITING_LIMIT);
  if (waiting.length) {
    regions.push({
      id: 'waiting',
      summary: `Waiting on ${waiting.length} ${waiting.length === 1 ? 'reply' : 'replies'}.`,
      tree: {
        kind: 'entity_list',
        emphasis: 'standard',
        tone: 'neutral',
        title: BRIEF_REGION_TITLES.waiting,
        variant: 'rows',
        items: waiting.map((item) =>
          laneItem(item, 'waiting', input.prose.lines[threadKey(item)] || item.whyItMatters, generatedAt),
        ),
      } as BriefNode,
    });
  }

  const tasks = light ? [] : tasksForBrief(sections.tasks, generatedAt, BUDGET_TASK_LIMIT, timezone);
  if (tasks.length) {
    regions.push({
      id: 'tasks',
      summary: `${tasks.length} ${tasks.length === 1 ? 'task is' : 'tasks are'} due this week.`,
      tree: {
        kind: 'entity_list',
        emphasis: 'standard',
        tone: 'neutral',
        title: BRIEF_REGION_TITLES.tasks,
        variant: 'rows',
        items: tasks.map((task) => taskItem(task, generatedAt, timezone)),
      } as BriefNode,
    });
  }

  const connected = light ? [] : rankConnectedItems(sections.mcp ?? [], generatedAt);
  if (connected.length) {
    regions.push({
      id: 'connected',
      summary: `${connected.length} connected ${connected.length === 1 ? 'item needs' : 'items need'} a look.`,
      tree: {
        kind: 'entity_list',
        emphasis: 'muted',
        tone: 'neutral',
        title: BRIEF_REGION_TITLES.connected,
        variant: 'rows',
        items: connected.map(connectedItem),
      } as BriefNode,
    });
  }

  if (weekAhead) {
    regions.push({
      id: 'week-ahead',
      summary: weekAhead,
      tree: { kind: 'text', emphasis: 'standard', tone: 'neutral', role: 'body', text: weekAhead },
    });
  }

  const areas = light
    ? []
    : (input.areas ?? []).filter((area) => area.areaId && area.name).slice(0, BUDGET_AREA_LIMIT);
  if (areas.length) {
    regions.push({
      id: 'areas',
      summary: `Areas: ${areas.map((area) => area.name).join(', ')}.`,
      tree: {
        kind: 'entity_list',
        emphasis: 'muted',
        tone: 'neutral',
        title: 'Areas',
        variant: 'compact',
        items: areas.map((area) => ({
          ref: { kind: 'area' as const, id: area.areaId, label: area.name },
          framing: area.line ? { reason: area.line } : {},
          actions: [
            {
              action: 'open_area',
              label: 'Open',
              payload: { areaId: area.areaId },
              style: 'quiet' as const,
            },
          ],
        })),
      } as BriefNode,
    });
  }

  return parseBriefDocument({
    version: 2,
    title: dailyBriefEditionTitleAt(generatedAt, timezone),
    summary: lede,
    generatedAt,
    timezone,
    regions,
  });
}
