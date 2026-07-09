// Pure helpers behind the Area home surface and the rail's areas list.
// No DOM, no React — everything here is bun:test-able in isolation.

export interface AreaHomeCountsLike {
  mail: number;
  events: number;
  tasks: number;
  facts: { verified: number; candidate: number };
}

export type AreaHomeSectionId = 'mail' | 'events' | 'tasks' | 'context';

export interface AreaHomeSection {
  id: AreaHomeSectionId;
  label: string;
  count: number;
}

// Fixed editorial order: the operational artifacts first (mail is the highest
// churn), the slow-moving context last. Sections always render — an empty
// section shows its own quiet empty state rather than vanishing, so the user
// learns what the classifier files here.
export function areaHomeSections(counts: AreaHomeCountsLike): AreaHomeSection[] {
  return [
    { id: 'mail', label: 'Mail', count: counts.mail },
    { id: 'events', label: 'Events', count: counts.events },
    { id: 'tasks', label: 'Tasks', count: counts.tasks },
    { id: 'context', label: 'Context', count: counts.facts.verified + counts.facts.candidate },
  ];
}

// True when the classifier has filed nothing at all — the page swaps the three
// artifact sections for one whole-page explanation (context still renders).
export function areaHasNoLinks(counts: AreaHomeCountsLike): boolean {
  return counts.mail + counts.events + counts.tasks === 0;
}

export const RAIL_AREA_CAP = 8;

// The rail shows at most `cap` areas; the rest collapse into one overflow row
// so a many-area life never turns the nav into a second inbox.
export function railAreaRows<T>(
  areas: T[] | undefined | null,
  cap = RAIL_AREA_CAP,
): {
  rows: T[];
  overflow: number;
} {
  const list = areas ?? [];
  if (list.length <= cap) return { rows: list, overflow: 0 };
  return { rows: list.slice(0, cap), overflow: list.length - cap };
}

// One quiet number per rail area row: facts awaiting the user's confirmation.
// Zero (or malformed counts) renders nothing — no ghost pill.
export function railAreaBadge(factCounts?: { candidate?: number } | null): string | null {
  const pending = Number(factCounts?.candidate ?? 0);
  if (!Number.isFinite(pending) || pending <= 0) return null;
  return pending >= 100 ? '99+' : String(Math.floor(pending));
}

const dayFormat = (locale: string) =>
  new Intl.DateTimeFormat(locale, { weekday: 'short', month: 'short', day: 'numeric' });
const timeFormat = (locale: string) =>
  new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' });

// One line of when: "Wed, Jul 8 · 2:00 PM – 3:30 PM", all-day and multi-day
// variants included. All-day events conventionally end at the next midnight,
// so the end is nudged back a minute before comparing days.
export function formatEventTime(startAt: number, endAt: number, allDay: boolean, locale = 'en-US'): string {
  const start = new Date(startAt);
  const end = new Date(endAt);
  const day = dayFormat(locale);
  if (allDay) {
    const adjustedEnd = new Date(Math.max(startAt, endAt - 60_000));
    if (start.toDateString() === adjustedEnd.toDateString()) return `${day.format(start)} · all day`;
    return `${day.format(start)} – ${day.format(adjustedEnd)} · all day`;
  }
  const time = timeFormat(locale);
  if (start.toDateString() === end.toDateString()) {
    return `${day.format(start)} · ${time.format(start)} – ${time.format(end)}`;
  }
  return `${day.format(start)} ${time.format(start)} – ${day.format(end)} ${time.format(end)}`;
}

export type TaskRowState = 'done' | 'overdue' | 'due' | 'open';

export interface TaskRowMeta {
  state: TaskRowState;
  label: string;
}

// One meta string per task row: done beats due, overdue is called out with the
// original date so the miss is legible, open-with-no-date stays quiet.
export function taskRowMeta(
  task: { completedAt: number | null; dueAt: number | null },
  now = Date.now(),
  locale = 'en-US',
): TaskRowMeta {
  const date = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' });
  if (task.completedAt) return { state: 'done', label: `Done ${date.format(new Date(task.completedAt))}` };
  if (task.dueAt != null) {
    if (task.dueAt < now)
      return { state: 'overdue', label: `Overdue · ${date.format(new Date(task.dueAt))}` };
    return { state: 'due', label: `Due ${date.format(new Date(task.dueAt))}` };
  }
  return { state: 'open', label: 'No due date' };
}

// ---------------------------------------------------------------------------
// Area Brief: the meaning-first home for one area. Plans, projects, and places
// stop being separate destinations and become components of the area itself.
// Everything below is pure so the same organizing logic runs in the Convex
// read model (convex/albatross.ts) and is unit-tested here.
// ---------------------------------------------------------------------------

// One active intent + its latest plan, flattened for the brief. Shaped by the
// areaHome query; rendered by the Plans section of the Area Brief.
export interface AreaPlanRow {
  intentId: string;
  title: string;
  status: string;
  planId: string | null;
  planStatus: string | null;
  outcome: string | null;
  summary: string | null;
  proposedProjectTitle: string | null;
  updatedAt: number;
}

export interface AreaProjectRow {
  projectId: string;
  title: string;
  outcome: string | null;
  status: string;
  sourceIntentId: string | null;
  updatedAt: number;
}

export interface AreaPlaceRow {
  name: string;
  detail: string | null;
  address: string | null;
  mapsUrl: string;
}

// A stable display title for an intent: its own title, else the first line of
// the raw dump, trimmed to one legible line. Never empty.
export function intentDisplayTitle(intent: { title?: string | null; rawText?: string | null }): string {
  const title = (intent.title || '').trim();
  if (title) return title;
  const raw = (intent.rawText || '').replace(/\s+/g, ' ').trim();
  if (!raw) return 'Untitled plan';
  return raw.length > 80 ? `${raw.slice(0, 79).trimEnd()}…` : raw;
}

export type PlanTone = 'active' | 'attention' | 'ready' | 'done' | 'neutral';

// One badge per plan row. 'needs_answers' is the only state that pulls the user
// in, so it outranks the intent's own status for tone.
export function planStatusMeta(
  intentStatus: string,
  planStatus?: string | null,
): { label: string; tone: PlanTone } {
  if (intentStatus === 'needs_answers' || planStatus === 'needs_answers')
    return { label: 'Needs answers', tone: 'attention' };
  switch (intentStatus) {
    case 'captured':
      return { label: 'Captured', tone: 'neutral' };
    case 'planning':
      return { label: 'Planning', tone: 'active' };
    case 'ready':
      return { label: 'Ready', tone: 'ready' };
    case 'applied':
      return { label: 'Applied', tone: 'active' };
    case 'done':
      return { label: 'Done', tone: 'done' };
    case 'archived':
      return { label: 'Archived', tone: 'neutral' };
    default:
      return { label: intentStatus || 'Plan', tone: 'neutral' };
  }
}

// The verb on a plan row's open button, matched to what the user would do next.
export function planActionLabel(intentStatus: string, planStatus?: string | null): string {
  if (intentStatus === 'needs_answers' || planStatus === 'needs_answers') return 'Answer questions';
  if (intentStatus === 'ready') return 'Review plan';
  if (intentStatus === 'applied' || intentStatus === 'done') return 'Open plan';
  return 'Open';
}

export interface AreaPulseInput {
  needsYou: number;
  plans: number;
  projects: number;
  places: number;
  upcoming: number;
}

export interface AreaPulseSegment {
  id: string;
  label: string;
}

// The one-line pulse under the area title: only the non-zero facets, in a fixed
// meaning-first order. Empty when the area is quiet — the strip then hides.
export function areaPulse(input: AreaPulseInput): AreaPulseSegment[] {
  const segments: AreaPulseSegment[] = [];
  const push = (id: string, n: number, one: string, many: string) => {
    if (n > 0) segments.push({ id, label: `${n} ${n === 1 ? one : many}` });
  };
  push('needsYou', input.needsYou, 'needs you', 'need you');
  push('plans', input.plans, 'active plan', 'active plans');
  push('projects', input.projects, 'project', 'projects');
  push('places', input.places, 'place', 'places');
  push('upcoming', input.upcoming, 'upcoming', 'upcoming');
  return segments;
}

export type NeedsYouKind = 'plan_answers' | 'overdue_task' | 'suggested_context';

export interface NeedsYouRow {
  id: string;
  kind: NeedsYouKind;
  title: string;
  detail: string | null;
  intentId?: string;
}

// The "needs you" queue: the few things in this area actually waiting on the
// user, ranked by how much they block. Plans awaiting answers come first (they
// stall the whole plan), then overdue tasks, then suggested context to confirm.
// Pure: it reads already-resolved arrays so it can be tested without a DB.
export function areaNeedsYouRows(
  input: {
    plans?: AreaPlanRow[] | null;
    tasks?: Array<{ cardId: string; title: string; completedAt: number | null; dueAt: number | null }> | null;
    candidateFacts?: Array<{ _id: string; kind: string; value: string }> | null;
  },
  now = Date.now(),
  cap = 6,
): NeedsYouRow[] {
  const rows: NeedsYouRow[] = [];
  for (const plan of input.plans ?? []) {
    if (plan.status === 'needs_answers' || plan.planStatus === 'needs_answers') {
      rows.push({
        id: `plan:${plan.intentId}`,
        kind: 'plan_answers',
        title: plan.title,
        detail: 'Answer questions to finish planning',
        intentId: plan.intentId,
      });
    }
  }
  for (const task of input.tasks ?? []) {
    if (task.completedAt == null && task.dueAt != null && task.dueAt < now) {
      rows.push({
        id: `task:${task.cardId}`,
        kind: 'overdue_task',
        title: task.title,
        detail: taskRowMeta(task, now).label,
      });
    }
  }
  for (const fact of input.candidateFacts ?? []) {
    rows.push({
      id: `fact:${fact._id}`,
      kind: 'suggested_context',
      title: fact.value,
      detail: `Suggested ${fact.kind}`,
    });
  }
  return rows.slice(0, cap);
}

export const AREA_PLACE_CAP = 8;

// A Google Maps search link from a single grounded query string. Same shape the
// plan generator uses (lib/albatross/intent-plan.ts) so links stay consistent.
export function mapsSearchUrl(query: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

interface PlacePartial {
  name?: string | null;
  detail?: string | null;
  address?: string | null;
  mapsQuery?: string | null;
}

interface OptionPartial {
  title?: string | null;
  detail?: string | null;
  address?: string | null;
}

// The real-world places this area's plans touch, deduped by name and capped.
// Grounded strings only: structured plan.places first, then a plan's declared
// mapQuery as a fallback place, then answer options that carry a real address
// (a place the web search surfaced) — never a free-text answer option.
export function extractAreaPlaces(
  plans?: Array<{ places?: PlacePartial[] | null; mapQuery?: string | null } | null | undefined> | null,
  optionSets?: Array<Array<OptionPartial | null | undefined> | null | undefined> | null,
  cap = AREA_PLACE_CAP,
): AreaPlaceRow[] {
  const out: AreaPlaceRow[] = [];
  const seen = new Set<string>();
  const add = (
    name?: string | null,
    detail?: string | null,
    address?: string | null,
    mapsQuery?: string | null,
  ) => {
    const clean = (name || '').trim();
    if (!clean) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const query = (mapsQuery || '').trim() || [clean, (address || '').trim()].filter(Boolean).join(', ');
    out.push({
      name: clean,
      detail: (detail || '').trim() || null,
      address: (address || '').trim() || null,
      mapsUrl: mapsSearchUrl(query),
    });
  };
  for (const plan of plans ?? []) {
    if (!plan) continue;
    const structured = plan.places ?? [];
    for (const place of structured) {
      if (place) add(place.name, place.detail, place.address, place.mapsQuery);
    }
    if (structured.length === 0 && plan.mapQuery) add(plan.mapQuery, null, null, plan.mapQuery);
  }
  for (const set of optionSets ?? []) {
    for (const option of set ?? []) {
      if (option && (option.address || '').trim()) add(option.title, option.detail, option.address, null);
    }
  }
  return out.slice(0, cap);
}
