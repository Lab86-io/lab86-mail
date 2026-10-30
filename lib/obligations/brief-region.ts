// Needs you in the Daily Brief (docs/needs-you-phases-2-5.md, S2 item 3;
// owner decision 9). For a user in LAB86_NEEDS_YOU the daily edition reads the
// ledger: the lane `needs-you` ("Needs you") takes the place of the `answer`
// lane. The edition stores the region data (BriefNeedsYouRegion) as
// `sections.needsYou`, and the document gets two regions:
//
//   "needs-you"       entity_list, title "Needs you", the items of the Now and
//                     Today groups (at most BRIEF_NEEDS_YOU_LIMIT, codes
//                     never). Each item has the item shape of the `answer`
//                     lane: ref, framing { lane, reason, sender, age }, actions.
//   "needs-you-note"  text role:aside, one plain line: the other open items,
//                     and "Closed by itself since yesterday's letter: ...".
//
// Users outside the flag keep `answer`. The brief never searches for
// obligations itself.

import { api, convexQuery } from '../hosted/convex';
import {
  BRIEF_DOCUMENT_LIMITS,
  type BriefDocumentV2,
  type BriefRegion,
  parseBriefDocument,
} from '../shared/brief-document';
import { normalizeBriefTimezone } from '../shared/brief-edition';
import { truncateText } from '../shared/text';
import type { DailyReport } from '../shared/types';
import {
  BRIEF_NEEDS_YOU_LIMIT,
  type BriefNeedsYouRegion,
  type NeedsYouSnapshot,
  needsYouFlagFor,
  OBLIGATION_SOURCE_LABELS,
  type ObligationClosedNote,
  type ObligationView,
} from './contract';
import { groupNeedsYou, needsYouSummary } from './groups';

export const NEEDS_YOU_LANE_ID = 'needs-you' as const;
export const NEEDS_YOU_NOTE_ID = 'needs-you-note' as const;
export const NEEDS_YOU_LANE_TITLE = 'Needs you';
/** At most this many items in "Closed by itself". */
export const BRIEF_NEEDS_YOU_CLOSED_LIMIT = 5;
/**
 * The stored region stays below this many bytes of JSON, so it never pushes
 * the edition over its storage ceiling (lib/store/daily-reports.ts).
 */
export const BRIEF_NEEDS_YOU_BYTE_LIMIT = 16_000;

const DAY_MS = 86_400_000;
// The lane takes the place of `answer`: before the first of these regions.
const AFTER_ANSWER = new Set(['today', 'know', 'waiting', 'tasks', 'connected', 'week-ahead', 'areas']);
// The lanes that can repeat a mail thread of the Needs you lane.
const THREAD_LANES = new Set(['today', 'know', 'waiting']);
const CONNECTED_SOURCES = new Set(['slack', 'atlassian', 'granola', 'drive', 'github', 'bitbucket']);

/** The DailyReport sections with the Needs you region. */
export type NeedsYouSections = DailyReport['sections'] & { needsYou?: BriefNeedsYouRegion };

function bytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/** The stored form of one item: no code, no draft state, short text. */
export function slimForBrief(view: ObligationView): ObligationView {
  const { code: _code, draftReady: _draftReady, closedAt: _closedAt, closeReason: _reason, ...rest } = view;
  return {
    ...rest,
    title: truncateText(rest.title, 300),
    asker: truncateText(rest.asker, 180),
    ...(rest.why ? { why: truncateText(rest.why, 300) } : {}),
    ...(rest.excerpt ? { excerpt: truncateText(rest.excerpt, 280) } : {}),
    ...(rest.sourceLabel ? { sourceLabel: truncateText(rest.sourceLabel, 120) } : {}),
    ...(rest.workTitle ? { workTitle: truncateText(rest.workTitle, 180) } : {}),
  };
}

function slimNote(note: ObligationClosedNote): ObligationClosedNote {
  return { ...note, title: truncateText(note.title, 300), asker: truncateText(note.asker, 180) };
}

/**
 * The region of one edition from the ledger: the counts, the Now items and
 * then the items due today (codes never), and the items that closed by
 * themselves since the previous edition.
 */
export function buildBriefNeedsYouRegion(input: {
  items: readonly ObligationView[];
  closed: readonly ObligationClosedNote[];
  now: number;
  timezone: string;
}): BriefNeedsYouRegion {
  const open = input.items.filter((item) => item.kind !== 'code');
  const groups = groupNeedsYou(open, [], input.now, input.timezone);
  const summary = needsYouSummary(groups);
  const entries = (id: string) => groups.find((group) => group.id === id)?.entries ?? [];
  const today = entries('today');
  const lane = [...entries('now'), ...today]
    .flatMap((entry) => (entry.type === 'obligation' ? [entry.obligation] : []))
    .slice(0, BRIEF_NEEDS_YOU_LIMIT);
  const region: BriefNeedsYouRegion = {
    id: NEEDS_YOU_LANE_ID,
    open: summary.open,
    now: summary.now,
    dueToday: today.length,
    items: lane.map(slimForBrief),
    closedSince: input.closed.slice(0, BRIEF_NEEDS_YOU_CLOSED_LIMIT).map(slimNote),
  };
  // Over the byte budget: the excerpts and the reasons go first, then items
  // from the end. The counts stay.
  if (bytes(region) > BRIEF_NEEDS_YOU_BYTE_LIMIT)
    region.items = region.items.map(({ excerpt: _excerpt, why: _why, ...item }) => item);
  // The closed notes are short and at most five, so the items are enough.
  while (bytes(region) > BRIEF_NEEDS_YOU_BYTE_LIMIT && region.items.length) region.items.pop();
  return region;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A stored region, or undefined when the value does not have its shape. */
export function parseBriefNeedsYouRegion(value: unknown): BriefNeedsYouRegion | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const region = value as Partial<BriefNeedsYouRegion>;
  if (
    region.id !== NEEDS_YOU_LANE_ID ||
    !isNumber(region.open) ||
    !isNumber(region.now) ||
    !isNumber(region.dueToday) ||
    !Array.isArray(region.items) ||
    !Array.isArray(region.closedSince)
  )
    return undefined;
  return {
    id: NEEDS_YOU_LANE_ID,
    open: region.open,
    now: region.now,
    dueToday: region.dueToday,
    items: region.items.filter(
      (item): item is ObligationView =>
        Boolean(item) && typeof item.id === 'string' && typeof item.title === 'string',
    ),
    closedSince: region.closedSince.filter(
      (note): note is ObligationClosedNote =>
        Boolean(note) && typeof note.id === 'string' && typeof note.title === 'string',
    ),
  };
}

/** The Needs you region of a stored edition, or null for an edition without one. */
export function editionNeedsYou(report: Pick<DailyReport, 'sections'>): BriefNeedsYouRegion | null {
  return parseBriefNeedsYouRegion((report.sections as NeedsYouSections | undefined)?.needsYou) ?? null;
}

/** The spread that keeps the region through the read migration of an edition. */
export function needsYouSectionOf(sections: unknown): { needsYou?: BriefNeedsYouRegion } {
  const region = parseBriefNeedsYouRegion((sections as { needsYou?: unknown } | undefined)?.needsYou);
  return region ? { needsYou: region } : {};
}

// ---- The document regions ---------------------------------------------------

function ageLabel(createdAt: number, generatedAt: number): string {
  if (!isNumber(createdAt) || createdAt >= generatedAt) return '';
  const days = Math.floor((generatedAt - createdAt) / DAY_MS);
  return days >= 1 ? `Day ${days + 1}` : '';
}

type LaneAction = {
  action: string;
  label: string;
  payload: Record<string, unknown>;
  style: 'primary' | 'secondary' | 'danger' | 'quiet';
};

function laneRef(view: ObligationView, label: string) {
  if (view.source === 'mail' && view.accountId && view.threadId)
    return { kind: 'thread' as const, id: view.threadId, account: view.accountId, label };
  if (view.eventId)
    return {
      kind: 'event' as const,
      id: view.eventId,
      ...(view.accountId ? { account: view.accountId } : {}),
      label,
    };
  if (CONNECTED_SOURCES.has(view.source))
    return { kind: 'mcp' as const, id: truncateText(view.sourceKey, 240) || `obligation:${view.id}`, label };
  return { kind: 'derived' as const, id: `obligation:${view.id}`, label };
}

/**
 * One lane item, in the item shape of the `answer` lane. The row tap opens
 * the source (the thread, the event, or the link); a mail reply also offers
 * Reply; an item of an Albatross offers it. An item with no place to open
 * opens the Needs you page.
 */
export function needsYouLaneItem(view: ObligationView, generatedAt: number) {
  const label = truncateText(view.title, BRIEF_DOCUMENT_LIMITS.shortText) || 'Needs you';
  const ref = laneRef(view, label);
  const place = [OBLIGATION_SOURCE_LABELS[view.source], view.sourceLabel].filter(Boolean).join(', ');
  // A thread or an event shows its own subject after hydration; the line is
  // then what the user owes. Other items show the title, so the line names
  // the place.
  const reason = ref.kind === 'thread' || ref.kind === 'event' ? label : place;
  const age = ageLabel(view.createdAt, generatedAt);
  const actions: LaneAction[] = [];
  const subject = { subject: label };
  if (ref.kind === 'thread') {
    const payload = { account: ref.account, threadId: ref.id, ...subject };
    actions.push({ action: 'open_thread', label: 'Open', payload, style: 'quiet' });
    if (view.kind === 'reply')
      actions.push({ action: 'draft_reply', label: 'Reply', payload, style: 'secondary' });
  } else if (ref.kind === 'event') {
    actions.push({
      action: 'open_event',
      label: 'Open',
      payload: { ...(view.accountId ? { account: view.accountId } : {}), eventId: ref.id },
      style: 'quiet',
    });
  } else if (view.url?.startsWith('https://')) {
    actions.push({ action: 'open_url', label: 'Open', payload: { url: view.url }, style: 'quiet' });
  }
  if (view.workId)
    actions.push({
      action: 'open_work',
      label: 'Open Albatross',
      payload: { workId: view.workId, ...(view.workTitle ? { title: view.workTitle } : {}) },
      style: 'quiet',
    });
  if (!actions.length)
    actions.push({
      action: 'open_view',
      label: 'Needs you',
      payload: { view: 'notifications', obligationId: view.id },
      style: 'quiet',
    });
  return {
    ref,
    framing: {
      lane: NEEDS_YOU_LANE_ID,
      ...(reason ? { reason } : {}),
      ...(view.asker ? { sender: truncateText(view.asker, 200) } : {}),
      ...(age ? { age } : {}),
    },
    actions,
  };
}

function plural(count: number, one: string, many: string) {
  return count === 1 ? one : many;
}

function dayKey(at: number, timezone: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: normalizeBriefTimezone(timezone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(at));
}

/** "yesterday's letter", "the last letter", or "yesterday" when no letter came before. */
export function sinceLetterPhrase(
  generatedAt: number,
  timezone: string,
  previousGeneratedAt?: number | null,
): string {
  if (!isNumber(previousGeneratedAt)) return 'yesterday';
  return dayKey(previousGeneratedAt, timezone) === dayKey(generatedAt - DAY_MS, timezone)
    ? "yesterday's letter"
    : 'the last letter';
}

/** The one plain line under the lane, or an empty string when it has nothing to say. */
export function needsYouNoteText(
  region: BriefNeedsYouRegion,
  options: { generatedAt: number; timezone: string; previousGeneratedAt?: number | null },
): string {
  const parts: string[] = [];
  const more = Math.max(0, region.open - region.items.length);
  if (more && region.items.length)
    parts.push(`${more} other open ${plural(more, 'item is', 'items are')} on the Needs you page.`);
  else if (more)
    parts.push(
      `${more} open ${plural(more, 'item is', 'items are')} on the Needs you page. None is due today.`,
    );
  if (region.closedSince.length) {
    const names = region.closedSince.map((note) => {
      const title = truncateText(note.title.replace(/\s+/g, ' ').trim(), 120);
      return note.asker ? `${title} (${truncateText(note.asker, 80)})` : title;
    });
    parts.push(
      `Closed by itself since ${sinceLetterPhrase(options.generatedAt, options.timezone, options.previousGeneratedAt)}: ${names.join('; ')}.`,
    );
  }
  return truncateText(parts.join(' '), BRIEF_DOCUMENT_LIMITS.body);
}

/** The document regions of the region: the lane when it has items, then the note when it has text. */
export function needsYouRegions(
  region: BriefNeedsYouRegion,
  options: { generatedAt: number; timezone: string; previousGeneratedAt?: number | null },
): BriefRegion[] {
  const regions: BriefRegion[] = [];
  if (region.items.length) {
    regions.push({
      id: NEEDS_YOU_LANE_ID,
      summary: `${NEEDS_YOU_LANE_TITLE}: ${region.now} now, ${region.dueToday} due today, ${region.open} open.`,
      tree: {
        kind: 'entity_list',
        emphasis: 'primary',
        tone: 'neutral',
        title: NEEDS_YOU_LANE_TITLE,
        variant: 'rows',
        items: region.items.map((item) => needsYouLaneItem(item, options.generatedAt)),
      },
    } as BriefRegion);
  }
  const note = needsYouNoteText(region, options);
  if (note)
    regions.push({
      id: NEEDS_YOU_NOTE_ID,
      summary: note,
      tree: { kind: 'text', emphasis: 'muted', tone: 'neutral', role: 'aside', text: note },
    });
  return regions;
}

function threadKey(ref: { account?: string; id: string }) {
  return `${ref.account ?? ''}:${ref.id}`;
}

/** A thread lane without the threads that the Needs you lane shows. Null when it is then empty. */
function withoutThreads(region: BriefRegion, threads: Set<string>): BriefRegion | null {
  if (!THREAD_LANES.has(region.id) || region.tree.kind !== 'entity_list' || !threads.size) return region;
  const items = region.tree.items.filter(
    (item) => item.ref.kind !== 'thread' || !threads.has(threadKey(item.ref)),
  );
  if (items.length === region.tree.items.length) return region;
  return items.length ? { ...region, tree: { ...region.tree, items } } : null;
}

/**
 * The composed letter with the Needs you regions in the place of the
 * `answer` lane. A thread of the Needs you lane leaves the Today, Know, and
 * Waiting lanes. Without a region, the document does not change.
 */
export function placeNeedsYouLane(
  document: BriefDocumentV2,
  region: BriefNeedsYouRegion | null | undefined,
  options: { generatedAt: number; timezone: string; previousGeneratedAt?: number | null },
): BriefDocumentV2 {
  if (!region) return document;
  const own = needsYouRegions(region, options);
  const threads = new Set(
    own
      .flatMap((entry) => (entry.tree.kind === 'entity_list' ? entry.tree.items : []))
      .filter((item) => item.ref.kind === 'thread')
      .map((item) => threadKey(item.ref)),
  );
  const regions: BriefRegion[] = [];
  let placed = false;
  for (const entry of document.regions) {
    if (entry.id === 'answer' || (!placed && AFTER_ANSWER.has(entry.id))) {
      if (!placed) regions.push(...own);
      placed = true;
      if (entry.id === 'answer') continue;
    }
    const kept = withoutThreads(entry, threads);
    if (kept) regions.push(kept);
  }
  if (!placed) regions.push(...own);
  // The document holds at most BRIEF_DOCUMENT_LIMITS.regions regions. The
  // note is the first to go; the edition still stores it.
  const fitted =
    regions.length > BRIEF_DOCUMENT_LIMITS.regions
      ? regions.filter((entry) => entry.id !== NEEDS_YOU_NOTE_ID)
      : regions;
  return parseBriefDocument({ ...document, regions: fitted });
}

// ---- The edition --------------------------------------------------------------

export interface BriefNeedsYouLoader {
  /** LAB86_NEEDS_YOU for the user (the Node flag). */
  flag(userId: string): boolean;
  snapshot(userId: string): Promise<NeedsYouSnapshot>;
  closedSince(userId: string, since: number): Promise<ObligationClosedNote[]>;
}

const loaderDefaults: BriefNeedsYouLoader = {
  flag: (userId) => needsYouFlagFor(userId),
  snapshot: (userId) => convexQuery<NeedsYouSnapshot>(api.obligationViews.snapshotFor, { userId }),
  closedSince: (userId, since) =>
    convexQuery<ObligationClosedNote[]>(api.obligationViews.closedSinceFor, {
      userId,
      since,
      limit: BRIEF_NEEDS_YOU_CLOSED_LIMIT,
    }),
};
let loader = loaderDefaults;

/** Tests replace the ledger reads. No argument restores the real ones. */
export function setBriefNeedsYouLoaderForTest(overrides: Partial<BriefNeedsYouLoader> = {}) {
  loader = { ...loaderDefaults, ...overrides };
}

/**
 * The edition with `sections.needsYou` for a user in the flag whose ledger is
 * on. Every other edition, and an edition whose ledger read fails, keeps the
 * `answer` lane and does not change.
 */
export async function withBriefNeedsYou(
  report: DailyReport,
  userId: string | null | undefined,
  since: number,
): Promise<DailyReport> {
  if (!userId || !loader.flag(userId)) return report;
  try {
    const snapshot = await loader.snapshot(userId);
    if (!snapshot?.enabled) return report;
    const closed = await loader.closedSince(userId, since);
    const sections: NeedsYouSections = {
      ...report.sections,
      needsYou: buildBriefNeedsYouRegion({
        items: snapshot.items,
        closed: Array.isArray(closed) ? closed : [],
        now: report.generatedAt,
        timezone: snapshot.timezone,
      }),
    };
    return { ...report, sections };
  } catch (error) {
    console.warn('[brief] the Needs you ledger read failed; the edition keeps the answer lane', {
      error: error instanceof Error ? error.name : 'UnknownError',
    });
    return report;
  }
}
