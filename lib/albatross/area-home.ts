// Pure helpers behind the Area home surface and the rail's areas list.
// No DOM, no React — everything here is bun:test-able in isolation.

export interface AreaHomeCountsLike {
  mail: number;
  events: number;
  tasks: number;
  facts: { verified: number; candidate: number };
}

export const PERSONAL_AREA_EXTERNAL_ID = 'system:personal';

export interface AreaFactLikeForBranding {
  kind?: string | null;
  value?: string | null;
  status?: string | null;
}

export interface AreaLikeForBranding {
  name?: string | null;
  primaryDomain?: string | null;
  faviconUrl?: string | null;
  imageUrl?: string | null;
}

export interface AreaBranding {
  primaryDomain: string | null;
  faviconUrl: string | null;
  imageUrl: string | null;
}

export type AreaHomeSectionId = 'mail' | 'events' | 'tasks' | 'context';

export interface AreaHomeSection {
  id: AreaHomeSectionId;
  label: string;
  count: number;
}

export interface AreaOverviewCountsLike {
  facts: { verified: number; candidate: number };
  mail: number;
  events: number;
  tasks: number;
  plans: number;
  projects: number;
  needsYou: number;
  overdueTasks: number;
  unreadMail: number;
  suggestedLinks: number;
}

export type AreaOverviewTone = 'attention' | 'active' | 'quiet';

export interface AreaOverviewBadge {
  id: string;
  label: string;
  tone: AreaOverviewTone;
}

// Bare, display-safe domain extraction. Handles URLs, emails, @domains, and
// plain domains from area facts without accepting arbitrary prose.
export function normalizeAreaDomain(value?: string | null): string | null {
  const raw = String(value || '')
    .trim()
    .toLowerCase();
  if (!raw) return null;
  const emailMatch = raw.match(/[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})/i);
  if (emailMatch?.[1]) return emailMatch[1].replace(/^www\./, '');
  let text = raw.replace(/^mailto:/, '').replace(/^@/, '');
  const protocolMatch = text.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i);
  if (protocolMatch?.[1]) text = protocolMatch[1];
  text = text
    .split(/[/?#\s]/)[0]
    .replace(/:\d+$/, '')
    .replace(/^www\./, '')
    .replace(/[),.;]+$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(text)) return null;
  if (text.length > 253 || text.split('.').some((part) => !part || part.length > 63)) return null;
  return text;
}

export function faviconUrlForDomain(domain?: string | null, size = 64): string | null {
  const normalized = normalizeAreaDomain(domain);
  if (!normalized) return null;
  const safeSize = Math.min(Math.max(Math.round(size) || 64, 16), 128);
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(normalized)}&sz=${safeSize}`;
}

function cleanOptionalUrl(value?: string | null): string | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) return null;
  return raw.slice(0, 800);
}

export function areaBrandingFromFacts(
  area?: AreaLikeForBranding | null,
  facts?: AreaFactLikeForBranding[] | null,
): AreaBranding {
  const byTrust = [...(facts ?? [])].sort((a, b) => {
    const rank = (fact: AreaFactLikeForBranding) => (fact.status === 'verified' ? 0 : 1);
    return rank(a) - rank(b);
  });
  const factDomain =
    byTrust
      .filter((fact) => /^(domain|website|url|email|sender|organization)$/i.test(String(fact.kind || '')))
      .map((fact) => normalizeAreaDomain(fact.value))
      .find(Boolean) ?? null;
  const primaryDomain = normalizeAreaDomain(area?.primaryDomain) ?? factDomain;
  return {
    primaryDomain,
    faviconUrl: cleanOptionalUrl(area?.faviconUrl) ?? faviconUrlForDomain(primaryDomain),
    imageUrl: cleanOptionalUrl(area?.imageUrl),
  };
}

export interface IntentAreaOption {
  _id: string;
  name: string;
  kind?: string | null;
  description?: string | null;
  externalId?: string | null;
  primaryDomain?: string | null;
}

export interface IntentAreaSuggestion {
  areaId: string;
  confidence: 'high' | 'medium';
  reason: string;
}

export interface AreaSelectionOption {
  _id: string;
  name?: string | null;
  kind?: string | null;
  externalId?: string | null;
}

export interface AreaSelectionResolution {
  areaId: string | null;
  state: 'chooser' | 'loading' | 'ready' | 'replaced' | 'missing';
}

export interface AreaIndexRunLike {
  status?: string | null;
  scanned?: number | null;
  inserted?: number | null;
  matched?: number | null;
  personal?: number | null;
  updatedAt?: number | null;
}

export interface AreaIndexMailLike {
  total?: number | null;
  ready?: number | null;
  indexing?: number | null;
  errored?: number | null;
  messagesSynced?: number | null;
}

export interface AreaIndexStatusLike {
  latestRun?: AreaIndexRunLike | null;
  mail?: AreaIndexMailLike | null;
}

export interface AreaIndexStatusSummary {
  label: string;
  tone: 'active' | 'done' | 'warning' | 'quiet';
}

function areaTextTokens(value?: string | null): string[] {
  return String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length >= 3);
}

export function suggestIntentArea(
  text: string,
  areas?: IntentAreaOption[] | null,
): IntentAreaSuggestion | null {
  const options = [...(areas ?? [])].filter((area) => area._id && area.name);
  if (!options.length) return null;
  const normalizedText = String(text || '').toLowerCase();
  const nonPersonal = options.filter((area) => area.externalId !== PERSONAL_AREA_EXTERNAL_ID);
  if (!normalizedText.trim()) return null;

  let best: { area: IntentAreaOption; score: number; reason: string } | null = null;
  for (const area of options) {
    let score = 0;
    const name = area.name.toLowerCase().trim();
    if (name && normalizedText.includes(name)) score += 8;
    const domain = normalizeAreaDomain(area.primaryDomain);
    if (domain && normalizedText.includes(domain)) score += 8;
    const tokens = new Set([...areaTextTokens(area.name), ...areaTextTokens(area.kind)]);
    for (const token of tokens) {
      if (normalizedText.includes(token)) score += 2;
    }
    for (const token of areaTextTokens(area.description).slice(0, 10)) {
      if (normalizedText.includes(token)) score += 1;
    }
    if (area.externalId === PERSONAL_AREA_EXTERNAL_ID) score -= 2;
    if (!best || score > best.score) {
      best = { area, score, reason: domain && normalizedText.includes(domain) ? domain : area.name };
    }
  }

  if (best && best.score >= 8) {
    return { areaId: best.area._id, confidence: 'high', reason: best.reason };
  }
  if (best && best.score >= 4) {
    return { areaId: best.area._id, confidence: 'medium', reason: best.reason };
  }
  if (options.length === 1) {
    return { areaId: options[0]._id, confidence: 'medium', reason: 'Only active area' };
  }
  if (nonPersonal.length === 0 && options.length === 1) {
    return { areaId: options[0]._id, confidence: 'medium', reason: 'Personal area' };
  }
  return null;
}

export function resolveAreaSelection(
  selectedAreaId: string | null | undefined,
  areas: AreaSelectionOption[] | undefined,
): AreaSelectionResolution {
  if (!selectedAreaId) return { areaId: null, state: 'chooser' };
  if (areas === undefined) return { areaId: selectedAreaId, state: 'loading' };
  const exact = areas.find((area) => area._id === selectedAreaId);
  if (exact) return { areaId: exact._id, state: 'ready' };
  if (selectedAreaId === PERSONAL_AREA_EXTERNAL_ID || selectedAreaId === 'personal') {
    const personal = areas.find(
      (area) =>
        area.externalId === PERSONAL_AREA_EXTERNAL_ID ||
        area.kind === 'personal' ||
        area.name?.toLowerCase() === 'personal',
    );
    if (personal) return { areaId: personal._id, state: 'replaced' };
  }
  return { areaId: null, state: 'missing' };
}

export function areaIndexStatusSummary(status?: AreaIndexStatusLike | null): AreaIndexStatusSummary | null {
  if (!status) return null;
  const run = status.latestRun ?? null;
  const mail = status.mail ?? null;
  const scanned = Math.max(0, Math.floor(Number(run?.scanned ?? 0)));
  const inserted = Math.max(0, Math.floor(Number(run?.inserted ?? 0)));
  const matched = Math.max(0, Math.floor(Number(run?.matched ?? 0)));
  const personal = Math.max(0, Math.floor(Number(run?.personal ?? 0)));
  const mailboxTotal = Math.max(0, Math.floor(Number(mail?.total ?? 0)));
  const mailboxIndexing = Math.max(0, Math.floor(Number(mail?.indexing ?? 0)));
  const mailboxErrored = Math.max(0, Math.floor(Number(mail?.errored ?? 0)));
  const messagesSynced = Math.max(0, Math.floor(Number(mail?.messagesSynced ?? 0)));

  if (run?.status === 'queued') return { label: 'Area filing queued', tone: 'active' };
  if (run?.status === 'running') {
    return {
      label: scanned ? `Filing areas · ${scanned.toLocaleString()} scanned` : 'Filing areas now',
      tone: 'active',
    };
  }
  if (run?.status === 'error') return { label: 'Area filing needs retry', tone: 'warning' };
  if (mailboxErrored > 0) {
    return {
      label: mailboxErrored === 1 ? '1 mailbox sync error' : `${mailboxErrored} mailbox sync errors`,
      tone: 'warning',
    };
  }
  if (mailboxIndexing > 0) {
    return {
      label:
        mailboxIndexing === 1
          ? `1 mailbox indexing${messagesSynced ? ` · ${messagesSynced.toLocaleString()} messages` : ''}`
          : `${mailboxIndexing} mailboxes indexing${messagesSynced ? ` · ${messagesSynced.toLocaleString()} messages` : ''}`,
      tone: 'active',
    };
  }
  if (run?.status === 'done') {
    const filed = inserted || matched + personal;
    return {
      label: filed
        ? `Area filing done · ${filed.toLocaleString()} filed`
        : scanned
          ? `Area filing done · ${scanned.toLocaleString()} scanned`
          : 'Area filing done',
      tone: 'done',
    };
  }
  if (mailboxTotal > 0) return { label: 'Mail index ready', tone: 'done' };
  return { label: 'Waiting for mailbox index', tone: 'quiet' };
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

// The Areas chooser is now a work-entry surface, not a directory. This score
// pulls areas with blockers and live work to the top while still letting the
// server's priority/name order break ties.
export function areaOverviewPriority(counts: AreaOverviewCountsLike): number {
  return (
    counts.needsYou * 160 +
    counts.overdueTasks * 80 +
    counts.plans * 24 +
    counts.events * 16 +
    counts.tasks * 12 +
    counts.unreadMail * 10 +
    counts.mail * 6 +
    counts.projects * 6 +
    counts.suggestedLinks * 4 +
    counts.facts.candidate * 2
  );
}

// Compact chooser badges: show why an area matters now, capped so cards do not
// become dashboards. Attention badges always win the first slots.
export function areaOverviewBadges(counts: AreaOverviewCountsLike, cap = 4): AreaOverviewBadge[] {
  const badges: AreaOverviewBadge[] = [];
  const push = (id: string, n: number, one: string, many: string, tone: AreaOverviewTone) => {
    if (n > 0) badges.push({ id, label: `${n} ${n === 1 ? one : many}`, tone });
  };
  push('needsYou', counts.needsYou, 'needs you', 'need you', 'attention');
  push('overdueTasks', counts.overdueTasks, 'overdue', 'overdue', 'attention');
  push('suggestedLinks', counts.suggestedLinks, 'suggestion', 'suggestions', 'attention');
  push('candidateFacts', counts.facts.candidate, 'context ask', 'context asks', 'attention');
  push('plans', counts.plans, 'plan', 'plans', 'active');
  push('events', counts.events, 'event', 'events', 'active');
  push('tasks', counts.tasks, 'task', 'tasks', 'active');
  push('unreadMail', counts.unreadMail, 'unread', 'unread', 'active');
  push('mail', counts.mail, 'thread', 'threads', 'quiet');
  push('projects', counts.projects, 'project', 'projects', 'quiet');
  return badges.slice(0, Math.max(0, cap));
}

export function areaOverviewStatus(counts: AreaOverviewCountsLike): string {
  if (counts.needsYou > 0)
    return `${counts.needsYou} ${counts.needsYou === 1 ? 'item needs' : 'items need'} you`;
  if (counts.plans > 0) return `${counts.plans} active ${counts.plans === 1 ? 'plan' : 'plans'}`;
  if (counts.events > 0 || counts.tasks > 0)
    return `${counts.events + counts.tasks} scheduled ${counts.events + counts.tasks === 1 ? 'item' : 'items'}`;
  if (counts.mail > 0) return `${counts.mail} filed ${counts.mail === 1 ? 'thread' : 'threads'}`;
  if (counts.facts.candidate > 0)
    return `${counts.facts.candidate} context ${counts.facts.candidate === 1 ? 'ask' : 'asks'}`;
  return 'Quiet';
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
  taskCount?: number;
  completedTaskCount?: number;
  activeSprint?: { title: string; status: string; endAt: number | null } | null;
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

export function areaBriefHeadline(input: {
  areaName: string;
  needsYou: number;
  upcoming: number;
  plans: number;
  projects: number;
  mail: number;
  tasks: number;
  candidateFacts: number;
}): string {
  if (input.needsYou > 0)
    return `${input.needsYou} ${input.needsYou === 1 ? 'item needs' : 'items need'} you before ${input.areaName} can move cleanly.`;
  if (input.upcoming > 0 && input.plans > 0)
    return `${input.upcoming} upcoming ${input.upcoming === 1 ? 'event' : 'events'} and ${input.plans} active ${input.plans === 1 ? 'plan' : 'plans'} are shaping ${input.areaName} today.`;
  if (input.plans > 0)
    return `${input.plans} active ${input.plans === 1 ? 'plan is' : 'plans are'} in motion for ${input.areaName}.`;
  if (input.mail + input.tasks + input.upcoming > 0)
    return `${input.areaName} has ${input.mail + input.tasks + input.upcoming} filed ${input.mail + input.tasks + input.upcoming === 1 ? 'signal' : 'signals'} to review.`;
  if (input.candidateFacts > 0)
    return `${input.areaName} is waiting on ${input.candidateFacts} context ${input.candidateFacts === 1 ? 'confirmation' : 'confirmations'}.`;
  return `${input.areaName} is quiet right now.`;
}

export interface BriefRows<T> {
  visible: T[];
  overflow: number;
  total: number;
}

// Fit each area brief to the viewport: show the highest-signal rows inline and
// send the long tail to the real deeper surfaces. This keeps the brief useful
// above the fold even when an area owns dozens of threads or tasks.
export function splitBriefRows<T>(rows: readonly T[] | null | undefined, limit: number): BriefRows<T> {
  const list = [...(rows ?? [])];
  const safeLimit = Math.max(0, Math.floor(limit));
  return {
    visible: list.slice(0, safeLimit),
    overflow: Math.max(0, list.length - safeLimit),
    total: list.length,
  };
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
