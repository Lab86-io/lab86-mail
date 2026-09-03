import type { AlbatrossDailyReportContext } from '../albatross/daily-report';
import { BRIEF_ITEM_BUDGET, BRIEF_LANE_CAPS, type BriefLane, type BriefPlanTier } from '../mail/brief-score';
import {
  type BriefDocumentV2,
  type BriefNode,
  type BriefRegion,
  parseBriefDocument,
} from '../shared/brief-document';
import { dailyBriefEditionTitleAt, normalizeBriefTimezone } from '../shared/brief-edition';
import { stripEmoji } from '../shared/format';
import type { DailyReportCalendarItem, DailyReportItem } from '../shared/types';

// The letter form of a brief (2026-09-03). A budget daily brief and an area
// pulse both render as one column of prose and rows. This module holds the
// pure parts: which documents are letters, how weekday names are marked, the
// footer count copy, and the fallback letter built from a stored edition.

/** The reading measure of the letter, in CSS pixels. */
export const BRIEF_LETTER_MEASURE_PX = 620;

export type BriefLetterKind = 'daily' | 'area';

export const DAILY_LETTER_REGION_IDS = ['lede', 'answer', 'today', 'know', 'week-ahead', 'areas'] as const;
export const AREA_LETTER_REGION_IDS = ['lede', 'pulse', 'ask', 'open-work'] as const;
export const DAILY_LETTER_LANE_IDS: readonly BriefLane[] = ['answer', 'today', 'know'];

const DAILY_LETTER_EVENT_LIMIT = 4;
const DAILY_LETTER_AREA_LIMIT = 3;

function isLedeHero(region: BriefRegion | undefined): boolean {
  if (!region || region.id !== 'lede' || region.tree.kind !== 'hero') return false;
  return region.tree.children.some((child) => child.kind === 'text' && child.role === 'lede');
}

/**
 * Returns the letter kind of a document, or null when the document uses the
 * older free layout. A letter starts with the `lede` hero and uses only the
 * region ids of one letter layout.
 */
export function briefLetterKind(document: Pick<BriefDocumentV2, 'regions'>): BriefLetterKind | null {
  const regions = document.regions;
  if (!regions.length || !isLedeHero(regions[0])) return null;
  const ids = regions.map((region) => region.id);
  if (new Set(ids).size !== ids.length) return null;
  const within = (allowed: readonly string[]) => ids.every((id) => allowed.includes(id));
  if (within(DAILY_LETTER_REGION_IDS)) return 'daily';
  if (within(AREA_LETTER_REGION_IDS)) return 'area';
  return null;
}

/** The text of the lede hero, or an empty string. */
export function briefLetterLede(document: Pick<BriefDocumentV2, 'regions'>): string {
  const region = document.regions[0];
  if (!isLedeHero(region) || region.tree.kind !== 'hero') return '';
  const lede = region.tree.children.find((child) => child.kind === 'text' && child.role === 'lede');
  return lede && lede.kind === 'text' ? lede.text : '';
}

/** True when a daily letter has no lane rows at all. */
export function briefLetterHasNoRows(document: Pick<BriefDocumentV2, 'regions'>): boolean {
  return !document.regions.some(
    (region) =>
      (DAILY_LETTER_LANE_IDS as readonly string[]).includes(region.id) &&
      region.tree.kind === 'entity_list' &&
      region.tree.items.length > 0,
  );
}

export const BRIEF_LETTER_EMPTY_COPY = 'Nothing needs an answer today. The week ahead is below.';
export const BRIEF_LETTER_FAILED_COPY = 'The brief did not write today. Write it again.';

// ---- Weekday marks -----------------------------------------------------------

export interface WeekdaySegment {
  text: string;
  weekday: boolean;
  /** Offset of the segment in the source text. */
  start: number;
}

const WEEKDAY_PATTERN = /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)s?\b/gi;

/**
 * Splits prose into plain and weekday segments. The renderer colors the
 * weekday segments. The model never writes markup; this is the only place a
 * weekday name is detected.
 */
export function markWeekdays(text: string): WeekdaySegment[] {
  const source = String(text || '');
  const segments: WeekdaySegment[] = [];
  let cursor = 0;
  for (const match of source.matchAll(WEEKDAY_PATTERN)) {
    const start = match.index ?? 0;
    if (start > cursor) segments.push({ text: source.slice(cursor, start), weekday: false, start: cursor });
    segments.push({ text: match[0], weekday: true, start });
    cursor = start + match[0].length;
  }
  if (cursor < source.length) segments.push({ text: source.slice(cursor), weekday: false, start: cursor });
  return segments;
}

// ---- Footer count ------------------------------------------------------------

/**
 * The one footer line of the daily letter. Null when there is nothing to
 * count. The count comes from `stats.noise` of the stored edition.
 */
export function noiseFooterCopy(noise: number | null | undefined): string | null {
  if (typeof noise !== 'number' || !Number.isFinite(noise) || noise <= 0) return null;
  const count = Math.floor(noise);
  return count === 1
    ? '1 other message did not need you today.'
    : `${count} other messages did not need you today.`;
}

// ---- Fallback letter from a stored edition ----------------------------------

// The fields of a stored item the letter reads. Web payload types carry a
// looser `lane`, so the input is a pick, not the shared item type.
export type BriefLetterItem = Pick<DailyReportItem, 'account' | 'threadId' | 'subject'> &
  Partial<Pick<DailyReportItem, 'people' | 'whyItMatters' | 'line' | 'sender'>>;
export type BriefLetterEvent = Pick<
  DailyReportCalendarItem,
  'account' | 'eventId' | 'title' | 'startAt' | 'endAt' | 'allDay' | 'location'
>;
export type BriefLetterLaneKey =
  | BriefLane
  | 'replyOwed'
  | 'followUpOwed'
  | 'timeSensitive'
  | 'tracked'
  | 'newPeople'
  | 'fyi';

export interface BriefLetterReportInput {
  generatedAt: number;
  narrative?: string;
  tier?: BriefPlanTier;
  prose?: { lede?: string; weekAhead?: string } | null;
  sections: Partial<Record<BriefLetterLaneKey, BriefLetterItem[]>> & {
    calendar?: BriefLetterEvent[];
    albatross?: Pick<AlbatrossDailyReportContext, 'includedAreas'> | null;
  };
}

function items(value: BriefLetterItem[] | undefined): BriefLetterItem[] {
  return Array.isArray(value) ? value : [];
}

function threadKey(item: Pick<DailyReportItem, 'account' | 'threadId'>): string {
  return `${item.account}:${item.threadId}`;
}

function dayKey(at: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(at));
}

function timeLabel(at: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(at));
}

/**
 * Picks the three lanes from a stored edition. Editions written from
 * 2026-09-03 carry `answer`, `today`, and `know`. Older editions map their
 * seven lanes onto the three, inside the tier budget.
 */
export function letterLanesFromSections(
  sections: BriefLetterReportInput['sections'],
  tier: BriefPlanTier | undefined,
): Record<BriefLane, BriefLetterItem[]> {
  const budget = BRIEF_ITEM_BUDGET[tier ?? 'pro'] ?? BRIEF_ITEM_BUDGET.pro;
  const hasBudgetLanes = ['answer', 'today', 'know'].some((lane) =>
    Array.isArray(sections[lane as BriefLane]),
  );
  const source: Record<BriefLane, BriefLetterItem[]> = hasBudgetLanes
    ? { answer: items(sections.answer), today: items(sections.today), know: items(sections.know) }
    : {
        answer: items(sections.replyOwed),
        today: items(sections.timeSensitive),
        know: [
          ...items(sections.followUpOwed),
          ...items(sections.tracked),
          ...items(sections.newPeople),
          ...items(sections.fyi),
        ],
      };
  const seen = new Set<string>();
  let remaining = budget;
  const lanes: Record<BriefLane, BriefLetterItem[]> = { answer: [], today: [], know: [] };
  for (const lane of DAILY_LETTER_LANE_IDS) {
    const cap = Math.min(remaining, BRIEF_LANE_CAPS[lane] ?? remaining);
    for (const item of source[lane]) {
      if (lanes[lane].length >= cap) break;
      const key = threadKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      lanes[lane].push(item);
    }
    remaining -= lanes[lane].length;
  }
  return lanes;
}

function laneNode(
  lane: BriefLane,
  laneItems: BriefLetterItem[],
  events: BriefLetterEvent[],
  timezone: string,
): BriefNode {
  const title = lane === 'answer' ? 'Answer' : lane === 'today' ? 'Today' : 'Know';
  return {
    kind: 'entity_list',
    emphasis: lane === 'answer' ? 'primary' : 'standard',
    tone: 'neutral',
    title,
    variant: 'rows',
    items: [
      ...events.map((event) => {
        const when = event.allDay
          ? 'All day'
          : `${timeLabel(event.startAt, timezone)} to ${timeLabel(event.endAt, timezone)}`;
        return {
          ref: { kind: 'event' as const, id: event.eventId, account: event.account, label: event.title },
          framing: { lane: 'today', reason: event.location ? `${when}, ${event.location}` : when },
          actions: [
            {
              action: 'open_event',
              label: 'Open',
              payload: { account: event.account, eventId: event.eventId },
              style: 'quiet' as const,
            },
          ],
        };
      }),
      ...laneItems.map((item) => {
        const line = stripEmoji(item.line || item.whyItMatters || '').trim();
        const sender = stripEmoji(item.sender || item.people?.[0] || '').trim();
        return {
          ref: {
            kind: 'thread' as const,
            id: item.threadId,
            account: item.account,
            label: stripEmoji(item.subject || '').trim() || '(no subject)',
          },
          framing: { lane, ...(line ? { reason: line } : {}), ...(sender ? { sender } : {}) },
          actions: [
            {
              action: 'open_thread',
              label: 'Open',
              payload: { account: item.account, threadId: item.threadId },
              style: 'quiet' as const,
            },
          ],
        };
      }),
    ],
  } as BriefNode;
}

/**
 * Builds the letter document from a stored edition when the edition has no
 * document of its own. The layout is the same as the composed letter: lede,
 * three lanes, week ahead, areas.
 */
export function briefLetterFromReport(
  report: BriefLetterReportInput,
  options: { timezone?: string | null } = {},
): BriefDocumentV2 {
  const timezone = normalizeBriefTimezone(options.timezone || undefined);
  const generatedAt = report.generatedAt || Date.now();
  const lede = stripEmoji(report.prose?.lede || report.narrative || '').trim() || 'Your brief is ready.';
  const weekAhead = stripEmoji(report.prose?.weekAhead || '').trim();
  const lanes = letterLanesFromSections(report.sections, report.tier);
  const today = dayKey(generatedAt, timezone);
  const events = (report.sections.calendar ?? [])
    .filter((event) => dayKey(event.startAt, timezone) === today)
    .sort((a, b) => a.startAt - b.startAt)
    .slice(0, DAILY_LETTER_EVENT_LIMIT);

  const regions: BriefRegion[] = [
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
    },
  ];
  for (const lane of DAILY_LETTER_LANE_IDS) {
    const laneEvents = lane === 'today' ? events : [];
    if (!lanes[lane].length && !laneEvents.length) continue;
    regions.push({
      id: lane,
      summary: `${lane === 'answer' ? 'Answer' : lane === 'today' ? 'Today' : 'Know'}: ${
        lanes[lane].length + laneEvents.length
      } items.`,
      tree: laneNode(lane, lanes[lane], laneEvents, timezone),
    });
  }
  if (weekAhead) {
    regions.push({
      id: 'week-ahead',
      summary: weekAhead,
      tree: { kind: 'text', emphasis: 'standard', tone: 'neutral', role: 'body', text: weekAhead },
    });
  }
  const areas = (report.sections.albatross?.includedAreas ?? [])
    .filter((area) => area.areaId && area.name)
    .slice(0, DAILY_LETTER_AREA_LIMIT);
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
        items: areas.map((area) => {
          const line = stripEmoji(area.reason || '').trim();
          return {
            ref: { kind: 'area' as const, id: area.areaId, label: stripEmoji(area.name).trim() || 'Area' },
            framing: line ? { reason: line } : {},
            actions: [
              {
                action: 'open_area',
                label: 'Open',
                payload: { areaId: area.areaId },
                style: 'quiet' as const,
              },
            ],
          };
        }),
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
