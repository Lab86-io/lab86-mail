import {
  type BriefDocumentV2,
  type BriefNode,
  type BriefRegion,
  parseBriefDocument,
} from '../shared/brief-document';
import { dailyBriefEditionTitleAt, normalizeBriefTimezone } from '../shared/brief-edition';
import type { DailyReport, DailyReportCalendarItem, DailyReportItem } from '../shared/types';
import { briefWeekDays, eventsByDay, localTimeLabel } from './brief-prose';
import type { BriefLane } from './brief-score';

// The deterministic composer of the budget brief (2026-09-03). The node
// layout is fixed; only the prose inside it comes from the model.
//
//   regions[0] "lede"        hero { text role:lede }
//   regions[n] "answer"      entity_list (thread refs, lane answer)     when items
//   regions[n] "today"       entity_list (event refs, then thread refs) when items or events
//   regions[n] "know"        entity_list (thread refs, lane know)       when items
//   regions[n] "week-ahead"  text role:body
//   regions[n] "areas"       entity_list variant:compact (area refs)    when areas, max 3
//
// Nothing else. Every entity item carries the real ref, `framing.lane`,
// `framing.reason` (the model's one line, may be absent), `framing.sender`,
// and one open action.

export const BUDGET_TODAY_EVENT_LIMIT = 4;
export const BUDGET_AREA_LIMIT = 3;

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
  report: Pick<DailyReport, 'generatedAt' | 'sections' | 'narrative'>;
  prose: { lede: string; weekAhead: string; lines: Record<string, string> };
  areas?: BudgetAreaLine[];
  timezone?: string | null;
}

function threadKey(item: Pick<DailyReportItem, 'account' | 'threadId'>) {
  return `${item.account}:${item.threadId}`;
}

function laneItem(item: DailyReportItem, lane: BriefLane, line: string | undefined) {
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
    },
    actions: [
      {
        action: 'open_thread',
        label: 'Open',
        payload: { account: item.account, threadId: item.threadId },
        style: 'quiet' as const,
      },
    ],
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

  const days = briefWeekDays(generatedAt, timezone, 1);
  const todayEvents = (eventsByDay(sections.calendar ?? [], days, timezone).get(days[0].dayKey) || []).slice(
    0,
    BUDGET_TODAY_EVENT_LIMIT,
  );

  for (const lane of ['answer', 'today', 'know'] as const) {
    const items = sections[lane] ?? [];
    const events = lane === 'today' ? todayEvents : [];
    if (!items.length && !events.length) continue;
    const children = [
      ...events.map((event) => eventItem(event, timezone)),
      ...items.map((item) => laneItem(item, lane, input.prose.lines[threadKey(item)])),
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

  if (weekAhead) {
    regions.push({
      id: 'week-ahead',
      summary: weekAhead,
      tree: { kind: 'text', emphasis: 'standard', tone: 'neutral', role: 'body', text: weekAhead },
    });
  }

  const areas = (input.areas ?? []).filter((area) => area.areaId && area.name).slice(0, BUDGET_AREA_LIMIT);
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
