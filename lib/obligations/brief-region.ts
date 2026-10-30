// Needs you in the Daily Brief (docs/needs-you-phases-2-5.md, S2 item 3;
// owner decision 9). For a user in LAB86_NEEDS_YOU the daily edition reads the
// ledger: the lane `needs-you` ("Needs you") takes the place of the `answer`
// lane. The edition stores the region data (BriefNeedsYouRegion) as
// `sections.needsYou`. The document shape (one shape for web, iOS, and macOS;
// see "Integration notes" in docs/needs-you-phases-2-5.md):
//
//   The letter region "needs-you" (the letter allow-list on both clients):
//     summary  the count sentence, "8 open · 2 now · 2 due today"
//     tree     entity_list, title "Needs you", the Now items and then the
//              items due today (framing.lane 'now' or 'today'), or a stack of
//              that list and one caption: the closed line. Without items, a
//              stack of the caption alone.
//   The editorial module "needs-you" (real daily editions are editorial):
//     one module, so the writer places the lane in one piece. Its story is a
//     group of generic nodes that every client renders as they are: the
//     title "Needs you", the count sentence as the kicker, the Now rows, a
//     "Due today" kicker and its rows, and the closed line as a caption.
//
// Users outside the flag keep `answer`. The brief never searches for
// obligations itself. This module has no static server import, so the
// clients can use the pure parts (the fallback letter, the editorial module).

import {
  BRIEF_DOCUMENT_LIMITS,
  type BriefContentLeaf,
  type BriefDocumentV2,
  type BriefNode,
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
export const NEEDS_YOU_LANE_TITLE = 'Needs you';
/** The lane shows this sub-label before the first row that is due today, after the Now rows. */
export const NEEDS_YOU_DUE_TODAY_LABEL = 'Due today';
/** The closed line starts with these words; the web letter sets them in bold. */
export const NEEDS_YOU_CLOSED_PREFIX = 'Closed by itself since';
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

function bytes(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
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
 * then the items due today (codes never), the items that closed by
 * themselves since the previous edition, and the time of that edition.
 */
export function buildBriefNeedsYouRegion(input: {
  items: readonly ObligationView[];
  closed: readonly ObligationClosedNote[];
  now: number;
  timezone: string;
  previousGeneratedAt?: number | null;
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
    ...(isNumber(input.previousGeneratedAt) ? { previousGeneratedAt: input.previousGeneratedAt } : {}),
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
    ...(isNumber(region.previousGeneratedAt) ? { previousGeneratedAt: region.previousGeneratedAt } : {}),
  };
}

/** The Needs you region of a stored edition, or null for an edition without one. */
export function editionNeedsYou(report: {
  sections?: { needsYou?: unknown } | null;
}): BriefNeedsYouRegion | null {
  return parseBriefNeedsYouRegion(report.sections?.needsYou) ?? null;
}

/** The spread that keeps the region through the read migration of an edition. */
export function needsYouSectionOf(sections: unknown): { needsYou?: BriefNeedsYouRegion } {
  const region = parseBriefNeedsYouRegion((sections as { needsYou?: unknown } | undefined)?.needsYou);
  return region ? { needsYou: region } : {};
}

// ---- The lane items -----------------------------------------------------------

function ageLabel(createdAt: number, generatedAt: number): string {
  if (!isNumber(createdAt) || createdAt >= generatedAt) return '';
  const days = Math.floor((generatedAt - createdAt) / DAY_MS);
  return days >= 1 ? `Day ${days + 1}` : '';
}

/** The sub-lane of one item: the Now group, or the items due today. */
export type NeedsYouLane = 'now' | 'today';

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
 * opens it on the Needs you page.
 */
export function needsYouLaneItem(view: ObligationView, generatedAt: number, lane: NeedsYouLane = 'today') {
  const label = truncateText(view.title, BRIEF_DOCUMENT_LIMITS.shortText) || NEEDS_YOU_LANE_TITLE;
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
      label: NEEDS_YOU_LANE_TITLE,
      payload: { view: 'notifications', obligationId: view.id },
      style: 'quiet',
    });
  return {
    ref,
    framing: {
      lane,
      ...(reason ? { reason } : {}),
      ...(view.asker ? { sender: truncateText(view.asker, 200) } : {}),
      ...(age ? { age } : {}),
    },
    actions,
  };
}

// ---- The lines ----------------------------------------------------------------

function plural(count: number, one: string, many: string) {
  return count === 1 ? one : many;
}

function dayKey(at: number, timezone: string | undefined) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: normalizeBriefTimezone(timezone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(at));
}

/** The count sentence of the lane: "8 open · 2 now · 2 due today". A zero part is left out. */
export function needsYouCountSentence(
  region: Pick<BriefNeedsYouRegion, 'open' | 'now' | 'dueToday'>,
): string {
  if (!region.open && !region.now && !region.dueToday) return 'Nothing open';
  return [
    `${region.open} open`,
    ...(region.now ? [`${region.now} now`] : []),
    ...(region.dueToday ? [`${region.dueToday} due today`] : []),
  ].join(' · ');
}

/** "yesterday’s letter", "the last letter", or "yesterday" when no letter came before. */
export function sinceLetterPhrase(
  generatedAt: number,
  timezone: string | undefined,
  previousGeneratedAt?: number | null,
): string {
  if (!isNumber(previousGeneratedAt)) return 'yesterday';
  return dayKey(previousGeneratedAt, timezone) === dayKey(generatedAt - DAY_MS, timezone)
    ? 'yesterday’s letter'
    : 'the last letter';
}

export interface NeedsYouLaneOptions {
  generatedAt: number;
  /** The user's IANA time zone. Left out or not valid: UTC. */
  timezone?: string;
  /** The previous edition. Left out: the time that the region stores. */
  previousGeneratedAt?: number | null;
}

/**
 * The one plain line at the end of the lane, or an empty string. It says
 * what closed by itself since the last letter. A lane without rows says
 * first where the open items are.
 */
export function needsYouClosedLine(region: BriefNeedsYouRegion, options: NeedsYouLaneOptions): string {
  const parts: string[] = [];
  if (!region.items.length && region.open)
    parts.push(
      `None is due today. ${region.open} open ${plural(region.open, 'item is', 'items are')} on the Needs you page.`,
    );
  if (region.closedSince.length) {
    const names = region.closedSince.map((note) => {
      const title = truncateText(note.title.replace(/\s+/g, ' ').trim(), 120);
      return note.asker ? `${title} (${truncateText(note.asker, 80)})` : title;
    });
    const previous = options.previousGeneratedAt ?? region.previousGeneratedAt;
    parts.push(
      `${NEEDS_YOU_CLOSED_PREFIX} ${sinceLetterPhrase(options.generatedAt, options.timezone, previous)}: ${names.join('; ')}.`,
    );
  }
  return truncateText(parts.join(' '), BRIEF_DOCUMENT_LIMITS.body);
}

// ---- The letter region and the editorial module -----------------------------

export type BriefEntityListNode = Extract<BriefContentLeaf, { kind: 'entity_list' }>;

export interface NeedsYouLaneParts {
  /** The rows, or null when the region has none. */
  list: BriefEntityListNode | null;
  /** The plain line at the end of the lane, or null. */
  closed: string | null;
}

/** The parts of the `needs-you` region tree. Any other tree reads as empty. */
export function needsYouLaneParts(tree: BriefNode): NeedsYouLaneParts {
  if (tree.kind === 'entity_list') return { list: tree, closed: null };
  if (tree.kind === 'stack') {
    const list = tree.children.find((child): child is BriefEntityListNode => child.kind === 'entity_list');
    const text = tree.children.find((child) => child.kind === 'text');
    const closed = text && text.kind === 'text' ? text.text.trim() : '';
    return { list: list ?? null, closed: closed || null };
  }
  return { list: null, closed: null };
}

const node = { emphasis: 'standard', tone: 'neutral' } as const;

/**
 * The letter region of the lane: the count sentence as its summary, the
 * rows, and the closed line. Null when the lane has nothing to show.
 */
export function needsYouLetterRegion(
  region: BriefNeedsYouRegion,
  options: NeedsYouLaneOptions,
): BriefRegion | null {
  const items = region.items.map((item, index) =>
    needsYouLaneItem(item, options.generatedAt, index < region.now ? 'now' : 'today'),
  );
  const list = items.length
    ? ({
        ...node,
        kind: 'entity_list',
        emphasis: 'primary',
        title: NEEDS_YOU_LANE_TITLE,
        variant: 'rows',
        items,
      } as BriefNode)
    : null;
  const line = needsYouClosedLine(region, options);
  const caption: BriefNode | null = line
    ? { ...node, kind: 'text', emphasis: 'muted', role: 'caption', text: line }
    : null;
  if (!list && !caption) return null;
  const children = [list, caption].filter((child): child is BriefNode => Boolean(child));
  return {
    id: NEEDS_YOU_LANE_ID,
    summary: needsYouCountSentence(region),
    tree:
      list && !caption
        ? list
        : { ...node, kind: 'stack', emphasis: 'primary', density: 'standard', children },
  };
}

/**
 * The story of the editorial module `needs-you`, from the letter region. It
 * uses only generic nodes (a group, entity lists, and text), so the editorial
 * renderers of web, iOS, and macOS show the title, the count sentence, the
 * "Due today" split, and the closed line with no lane code. The items lose
 * `framing.lane`: the kicker carries the split, so the rows show no lane word.
 */
export function needsYouEditorialStory(region: BriefRegion): BriefNode | null {
  if (region.id !== NEEDS_YOU_LANE_ID) return null;
  const parts = needsYouLaneParts(region.tree);
  const strip = (item: BriefEntityListNode['items'][number]) => {
    const { lane: _lane, ...framing } = item.framing;
    return { ...item, framing };
  };
  const items = parts.list?.items ?? [];
  const now = items.filter((item) => item.framing.lane === 'now').map(strip);
  const today = items.filter((item) => item.framing.lane !== 'now').map(strip);
  const rows = (entries: typeof now, emphasis: 'primary' | 'standard') =>
    ({ ...node, kind: 'entity_list', emphasis, variant: 'rows', items: entries }) as BriefNode;
  const children: BriefNode[] = [
    ...(now.length ? [rows(now, 'primary')] : []),
    ...(now.length && today.length
      ? [{ ...node, kind: 'text', role: 'kicker', text: NEEDS_YOU_DUE_TODAY_LABEL } as BriefNode]
      : []),
    ...(today.length ? [rows(today, now.length ? 'standard' : 'primary')] : []),
    ...(parts.closed
      ? [{ ...node, kind: 'text', emphasis: 'muted', role: 'caption', text: parts.closed } as BriefNode]
      : []),
  ];
  if (!children.length) return null;
  return {
    ...node,
    kind: 'group',
    emphasis: 'primary',
    title: NEEDS_YOU_LANE_TITLE,
    kicker: truncateText(region.summary, 120),
    surface: 'elevated',
    collapsible: false,
    children,
  } as BriefNode;
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
 * The letter with the Needs you region in the place of the `answer` lane. A
 * thread of the Needs you lane leaves the Today, Know, and Waiting lanes.
 * Without a region, the document does not change. The composer, the live
 * projection of a stored edition, and the fallback letter use it.
 */
export function placeNeedsYouLane(
  document: BriefDocumentV2,
  region: BriefNeedsYouRegion | null | undefined,
  options: NeedsYouLaneOptions,
): BriefDocumentV2 {
  if (!region) return document;
  const own = needsYouLetterRegion(region, options);
  const list = own ? needsYouLaneParts(own.tree).list : null;
  const threads = new Set(
    (list?.items ?? []).filter((item) => item.ref.kind === 'thread').map((item) => threadKey(item.ref)),
  );
  const regions: BriefRegion[] = [];
  let placed = false;
  for (const entry of document.regions) {
    if (entry.id === NEEDS_YOU_LANE_ID) continue;
    if (entry.id === 'answer' || (!placed && AFTER_ANSWER.has(entry.id))) {
      if (!placed && own) regions.push(own);
      placed = true;
      if (entry.id === 'answer') continue;
    }
    const kept = withoutThreads(entry, threads);
    if (kept) regions.push(kept);
  }
  if (!placed && own) regions.push(own);
  // parseBriefDocument keeps the first BRIEF_DOCUMENT_LIMITS.regions regions.
  return parseBriefDocument({ ...document, regions });
}

// ---- The edition --------------------------------------------------------------

export interface BriefNeedsYouLoader {
  /** LAB86_NEEDS_YOU for the user (the Node flag). */
  flag(userId: string): boolean;
  snapshot(userId: string): Promise<NeedsYouSnapshot>;
  closedSince(userId: string, since: number): Promise<ObligationClosedNote[]>;
}

// The Convex client loads only when the brief reads the ledger on the
// server, so a client bundle that uses the pure parts never holds it.
const convex = () => import('../hosted/convex');

const loaderDefaults: BriefNeedsYouLoader = {
  flag: (userId) => needsYouFlagFor(userId),
  snapshot: async (userId) => {
    const { api, convexQuery } = await convex();
    return convexQuery<NeedsYouSnapshot>(api.obligationViews.snapshotFor, { userId });
  },
  closedSince: async (userId, since) => {
    const { api, convexQuery } = await convex();
    return convexQuery<ObligationClosedNote[]>(api.obligationViews.closedSinceFor, {
      userId,
      since,
      limit: BRIEF_NEEDS_YOU_CLOSED_LIMIT,
    });
  },
};
let loader = loaderDefaults;

/** Tests replace the ledger reads. No argument restores the real ones. */
export function setBriefNeedsYouLoaderForTest(overrides: Partial<BriefNeedsYouLoader> = {}) {
  loader = { ...loaderDefaults, ...overrides };
}

/**
 * The edition with `sections.needsYou` for a user in the flag whose ledger is
 * on. Every other edition, and an edition whose ledger read fails, keeps the
 * `answer` lane and does not change. `previousGeneratedAt` is the time of the
 * previous edition, for the words of the closed line.
 */
export async function withBriefNeedsYou(
  report: DailyReport,
  userId: string | null | undefined,
  since: number,
  previousGeneratedAt?: number | null,
): Promise<DailyReport> {
  if (!userId || !loader.flag(userId)) return report;
  try {
    const snapshot = await loader.snapshot(userId);
    if (!snapshot?.enabled) return report;
    const closed = await loader.closedSince(userId, since);
    return {
      ...report,
      sections: {
        ...report.sections,
        needsYou: buildBriefNeedsYouRegion({
          items: snapshot.items,
          closed: Array.isArray(closed) ? closed : [],
          now: report.generatedAt,
          timezone: snapshot.timezone,
          previousGeneratedAt,
        }),
      },
    };
  } catch (error) {
    console.warn('[brief] the Needs you ledger read failed; the edition keeps the answer lane', {
      error: error instanceof Error ? error.name : 'UnknownError',
    });
    return report;
  }
}
