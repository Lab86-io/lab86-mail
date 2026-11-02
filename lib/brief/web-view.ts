// The web Today page reads this view of an edition, not the stored row. The
// row keeps every field for native readers (lib/mobile/v1 and the
// get_latest_daily_report tool), so those reads keep their exact shape. This
// view holds only what the page renders, and it is a list of allowed fields, so
// a new large field on the row does not reach the browser by accident.

import { type BriefService, briefServiceIdForMcpItem } from '../mail/brief-services';
import { needsYouSectionOf } from '../obligations/brief-region';
import type { BriefDocumentV2 } from '../shared/brief-document';
import { truncateText } from '../shared/text';
import type {
  DailyReport,
  DailyReportArtifactError,
  DailyReportCalendarItem,
  DailyReportItem,
} from '../shared/types';
import { isBriefEditionGenerating } from './generation';
import type { BriefLetterEvent, BriefLetterItem } from './letter';

/** The backlog list shows this many rows. The count in its summary stays the full count. */
export const BRIEF_BACKLOG_LIMIT = 60;
const BRIEF_BACKLOG_TEXT_CHARS = 160;

/** The stamp of a user with no active daily job. */
export const BRIEF_HEAD_IDLE = 'idle';

/** The poll of the page reads this small state from the active daily job. */
export interface BriefEditionHead {
  reportId: string;
  status?: 'partial' | 'ready' | null;
  artifactStatus?: string | null;
  retrying?: boolean | null;
  progress?: { stage: string; done: number; total: number } | null;
}

/**
 * The edition that the writer works on now. `writing`: its row has nothing to
 * read yet, so the page keeps the last readable edition. `composing`: its row
 * has a readable letter, and the page shows that letter.
 */
export interface BriefPendingEdition {
  reportId: string;
  phase: 'writing' | 'composing';
  progress?: { stage: string; done: number; total: number };
}

export type BriefBacklogItem = Pick<DailyReportItem, 'account' | 'threadId' | 'subject' | 'whyItMatters'>;

export interface BriefWebSections {
  overflow?: BriefBacklogItem[];
  answer?: BriefLetterItem[];
  today?: BriefLetterItem[];
  know?: BriefLetterItem[];
  replyOwed?: BriefLetterItem[];
  followUpOwed?: BriefLetterItem[];
  timeSensitive?: BriefLetterItem[];
  tracked?: BriefLetterItem[];
  newPeople?: BriefLetterItem[];
  fyi?: BriefLetterItem[];
  calendar?: BriefLetterEvent[];
  albatross?: DailyReport['sections']['albatross'] | { includedAreas: unknown[] };
  needsYou?: unknown;
}

export interface BriefWebEdition {
  _id: string;
  kind: DailyReport['kind'];
  first?: boolean;
  light?: boolean;
  generatedAt: number;
  title?: string;
  narrative?: string;
  status?: 'partial' | 'ready';
  retrying?: boolean;
  services?: string[];
  tier?: DailyReport['tier'];
  errors?: string[];
  artifactStatus?: DailyReport['artifactStatus'];
  artifactSource?: DailyReport['artifactSource'];
  artifactErrors?: DailyReportArtifactError[];
  document?: BriefDocumentV2;
  html?: string;
  prose?: { lede?: string; weekAhead?: string; model?: string } | null;
  stats?: { noise?: number; overflow?: number };
  sections: BriefWebSections;
}

/** What the page polls: no edition, only whether a read is worth its cost. */
export interface BriefHeadResponse {
  stamp: string;
  pending: BriefPendingEdition | null;
}

/** One read of the page. `unchanged` means that the reader has this edition already. */
export interface BriefViewResponse extends BriefHeadResponse {
  revision: string | null;
  report?: BriefWebEdition | null;
  unchanged?: boolean;
  /** The page shows an older edition, because the newest has nothing in it. */
  failedNewer?: boolean;
}

/** One state change of the active job moves this stamp. Progress within a state does not. */
export function briefHeadStamp(head: BriefEditionHead | null | undefined): string {
  if (!head) return BRIEF_HEAD_IDLE;
  return [head.reportId, head.status ?? '', head.artifactStatus ?? '', head.retrying ? 'retry' : ''].join(
    '|',
  );
}

export function briefPendingFromHead(head: BriefEditionHead | null | undefined): BriefPendingEdition | null {
  if (!head || !isBriefEditionGenerating(head)) return null;
  return {
    reportId: head.reportId,
    phase: head.status === 'partial' ? 'writing' : 'composing',
    ...(head.progress ? { progress: head.progress } : {}),
  };
}

export const BRIEF_POLL_IDLE_MS = 30_000;
export const BRIEF_POLL_PENDING_MS = 10_000;
export const BRIEF_POLL_NOTHING_READABLE_MS = 3_000;
/** The page reads the edition and its live mail facts again at this interval. */
export const BRIEF_LIVE_REFRESH_MS = 3 * 60_000;

/** How often the page polls the head of the active job. */
export function briefHeadPollInterval(state: {
  selected: boolean;
  pending: boolean;
  retrying: boolean;
  readable: boolean;
}): number | false {
  if (state.pending && !state.readable) return BRIEF_POLL_NOTHING_READABLE_MS;
  if (state.pending || state.retrying) return BRIEF_POLL_PENDING_MS;
  return state.selected ? false : BRIEF_POLL_IDLE_MS;
}

function backlogItem(item: DailyReportItem): BriefBacklogItem {
  return {
    account: item.account,
    threadId: item.threadId,
    subject: truncateText(item.subject ?? '', BRIEF_BACKLOG_TEXT_CHARS),
    whyItMatters: truncateText(item.whyItMatters ?? '', BRIEF_BACKLOG_TEXT_CHARS),
  };
}

function letterItem(item: DailyReportItem): BriefLetterItem {
  return {
    account: item.account,
    threadId: item.threadId,
    subject: item.subject,
    ...(item.line ? { line: item.line } : {}),
    ...(item.whyItMatters ? { whyItMatters: item.whyItMatters } : {}),
    ...(item.sender ? { sender: item.sender } : {}),
    ...(item.people?.[0] ? { people: [item.people[0]] } : {}),
  };
}

function letterEvent(event: DailyReportCalendarItem): BriefLetterEvent {
  return {
    account: event.account,
    eventId: event.eventId,
    title: event.title,
    startAt: event.startAt,
    endAt: event.endAt,
    ...(event.allDay ? { allDay: event.allDay } : {}),
    ...(event.location ? { location: event.location } : {}),
  };
}

/** The sources behind an edition, for the footer. Keeps only ids, not the items. */
export function briefEditionServiceIds(report: DailyReport): Array<BriefService['id'] | string> {
  const sections: Partial<DailyReport['sections']> = report.sections ?? {};
  return [
    ...new Set([
      ...(report.services ?? []),
      ...(sections.mcp ?? []).map(briefServiceIdForMcpItem),
      ...(sections.calendar?.length ? ['calendar'] : []),
      ...((sections.tasks ?? []).some((task) => !task.completedAt) ? ['tasks'] : []),
    ]),
  ];
}

const LETTER_LANES = [
  'answer',
  'today',
  'know',
  'replyOwed',
  'followUpOwed',
  'timeSensitive',
  'tracked',
  'newPeople',
  'fyi',
] as const;

/**
 * The fields of one edition that the page renders. A document edition sends its
 * document and the backlog rows. An older model-written page sends its HTML. An
 * edition without either sends the lane fields of the fallback letter.
 */
export function briefWebEdition(report: DailyReport): BriefWebEdition {
  const sections: Partial<DailyReport['sections']> = report.sections ?? {};
  const overflow = sections.overflow ?? [];
  const source =
    report.artifactSource ?? (typeof report.html === 'string' && report.html ? 'ai' : 'deterministic');
  const base: BriefWebEdition = {
    _id: report._id,
    kind: report.kind,
    ...(report.first ? { first: true } : {}),
    ...(report.light ? { light: true } : {}),
    generatedAt: report.generatedAt,
    title: report.title,
    status: report.status,
    ...(report.retrying ? { retrying: true } : {}),
    services: briefEditionServiceIds(report) as string[],
    artifactStatus: report.artifactStatus,
    artifactSource: source,
    stats: {
      ...(typeof report.stats?.noise === 'number' ? { noise: report.stats.noise } : {}),
      overflow: overflow.length,
    },
    sections: {},
  };
  const backlog = overflow.slice(0, BRIEF_BACKLOG_LIMIT).map(backlogItem);
  if (source === 'document-v2' && report.document)
    return { ...base, document: report.document, sections: { overflow: backlog } };
  if (source === 'ai' && report.html)
    return { ...base, html: report.html, sections: { albatross: sections.albatross } };
  const lanes: BriefWebSections = {};
  for (const lane of LETTER_LANES) {
    // An absent lane stays absent: the letter tells a budget edition from a
    // seven-lane edition by the lanes that the edition wrote.
    const items = sections[lane];
    if (Array.isArray(items)) lanes[lane] = items.map(letterItem);
  }
  return {
    ...base,
    narrative: report.narrative,
    tier: report.tier,
    prose: report.prose ? { lede: report.prose.lede, weekAhead: report.prose.weekAhead } : null,
    ...(report.errors?.length ? { errors: report.errors } : {}),
    sections: {
      ...lanes,
      overflow: backlog,
      calendar: (sections.calendar ?? []).map(letterEvent),
      ...(sections.albatross
        ? {
            albatross: {
              includedAreas: (sections.albatross.includedAreas ?? []).map((area) => ({
                areaId: area.areaId,
                name: area.name,
                reason: area.reason,
              })),
            },
          }
        : {}),
      ...needsYouSectionOf(sections),
    },
  };
}
