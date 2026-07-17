// Pure helpers behind the Area home surface and the rail's areas list.
// No DOM, no React — everything here is bun:test-able in isolation.

export interface AreaHomeCountsLike {
  mail: number;
  events: number;
  tasks: number;
  facts: { verified: number; candidate: number };
}

// Retired (#100). Areas are an opt-in, sparse overlay: mail belongs to zero or
// more active Areas, and zero is a successful verdict — so there is no system
// catch-all any more. This id survives only so the cleanup pass can recognise
// and retire rows the old auto-created "Personal" area left behind. Nothing
// creates, protects, or routes to it. A user may create an ordinary Area named
// "Personal" like any other; it will not carry this externalId.
export const LEGACY_PERSONAL_AREA_EXTERNAL_ID = 'system:personal';

// Bump to make every thread eligible for re-routing. Automatic Area decisions
// carry the version that produced them, so a bump lets newer verdicts supersede
// older candidate links without touching anything the user confirmed.
//   1 — pre-#100: subject/snippet batch prompt, Personal catch-all fallback.
//   2 — #100: per-message body-grounded structured verdicts, sparse, no fallback.
export const AREA_CLASSIFIER_VERSION = 2;

// Consumer mailbox domains are shared by millions of unrelated senders, so an
// exact-domain fact over one of them is not identity evidence and must never
// route. (An exact *email* fact on such a domain still may — it identifies one
// person.) Kept deliberately small and explicit rather than heuristic.
const SHARED_CONSUMER_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'ymail.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'gmx.com',
  'mail.com',
  'zoho.com',
  'yandex.com',
  'fastmail.com',
  'hey.com',
  'qq.com',
  '163.com',
  'naver.com',
]);

export function isSharedConsumerDomain(value?: string | null): boolean {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^@/, '');
  return SHARED_CONSUMER_DOMAINS.has(normalized);
}

export interface AreaLinkLike {
  areaId?: string | null;
  status?: string | null;
  reason?: string | null;
  classifierVersion?: number | null;
  sourceRefs?: Array<{ kind?: string | null; id?: string | null }> | null;
  confirmationRefs?: Array<{ kind?: string | null; prompt?: string | null }> | null;
}

function hasAutomaticAreaSignature(link: AreaLinkLike): boolean {
  const reason = String(link.reason || '').toLowerCase();
  if (reason.includes('fallback to personal')) return true;
  if (/^llm\b/.test(reason)) return true;
  if (/^(verified|candidate)\s+(email|domain)\b/.test(reason)) return true;
  return (link.sourceRefs || []).some(
    (ref) =>
      ref?.kind === 'areaContext' ||
      ref?.kind === 'areaFact' ||
      ref?.kind === 'area' ||
      (ref?.kind === 'system' && ref?.id === 'area-reindex'),
  );
}

/**
 * The user stands behind this link: they verified it, they rejected it, or they
 * confirmed it directly. Authoritative in both directions — a `verified` link is
 * never rewritten by a classifier, and a `rejected` link is a tombstone that
 * stops the classifier re-proposing the same area forever.
 */
export function isUserAuthoritativeLink(link: AreaLinkLike): boolean {
  if (link.status === 'rejected') return true;
  const directConfirmation = (link.confirmationRefs || []).some(
    (ref) =>
      ref?.kind === 'userConfirmation' &&
      !String(ref.prompt || '')
        .toLowerCase()
        .includes('inherited from a user-verified area identity fact'),
  );
  if (directConfirmation) return true;
  // Versioned links are classifier output. Their remaining confirmation refs
  // are inherited from an identity fact; that confirms the fact, not this
  // derived thread assignment.
  if (typeof link.classifierVersion === 'number') return false;
  if (hasAutomaticAreaSignature(link)) return false;
  return link.status === 'verified';
}

/**
 * This link was produced by a classifier or a backfill, not by a person.
 *
 * Links written since #100 carry `classifierVersion`, which settles it. Older
 * rows predate that field, so they're recognised by the signatures the previous
 * pipeline left behind (its reason strings and sourceRef kinds). Anything that
 * matches neither is treated as user-authored and left alone — when in doubt,
 * don't touch the user's data.
 */
export function isAutomaticAreaLink(link: AreaLinkLike): boolean {
  if (link.status === 'rejected') return false;
  if (isUserAuthoritativeLink(link)) return false;
  if (typeof link.classifierVersion === 'number') return true;
  return hasAutomaticAreaSignature(link);
}

export function isDeterministicAutomaticAreaLink(link: AreaLinkLike): boolean {
  if (!isAutomaticAreaLink(link)) return false;
  const reason = String(link.reason || '').toLowerCase();
  return (
    /^verified\s+(email|domain)\b/.test(reason) &&
    (link.sourceRefs || []).some((ref) => ref?.kind === 'areaFact' || ref?.kind === 'area')
  );
}

export function shouldRetireDeterministicAreaLink(
  link: AreaLinkLike,
  match?: { areaId: string; factId: string } | null,
): boolean {
  if (!isDeterministicAutomaticAreaLink(link)) return false;
  if (!match || String(link.areaId || '') !== match.areaId) return true;
  return !(link.sourceRefs || []).some((ref) => ref?.kind === 'areaFact' && ref.id === match.factId);
}

/**
 * An automatic decision no newer than the incoming classifier. A verdict for a
 * newer message may replace a same-version decision; a version bump also
 * supersedes older decisions. User-authoritative links never qualify.
 */
export function isSupersedableAreaLink(link: AreaLinkLike, currentVersion: number): boolean {
  return isAutomaticAreaLink(link) && (link.classifierVersion ?? 0) <= currentVersion;
}

/**
 * Weak evidence that should never have routed: the system Personal catch-all,
 * and `areaContext` sourceRefs (general/candidate context rather than a
 * confirmed identity fact). Retired on reindex, but only while still an
 * unconfirmed automatic candidate — a Personal link the user confirmed is a
 * decision they made and survives.
 */
export function isWeakAutomaticAreaLink(link: AreaLinkLike): boolean {
  if (isUserAuthoritativeLink(link)) return false;
  const reason = String(link.reason || '').toLowerCase();
  if (reason.includes('fallback to personal')) return true;
  return (link.sourceRefs || []).some(
    (ref) => ref?.kind === 'areaContext' || (ref?.kind === 'system' && ref?.id === 'area-reindex'),
  );
}

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

export function areaInitials(name?: string | null) {
  const words = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return 'A';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0] || ''}${words.at(-1)?.[0] || ''}`.toUpperCase();
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

export function areaFactIdentity(
  kind: string,
  value: string,
): { kind: 'email' | 'domain'; value: string } | null {
  const declaredKind = String(kind || '')
    .trim()
    .toLowerCase();
  if (declaredKind !== 'email' && declaredKind !== 'domain') return null;
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^mailto:/, '')
    .replace(/^@/, '');
  if (!normalized || /\s/.test(normalized)) return null;
  if (declaredKind === 'email') {
    return normalized.includes('@') ? { kind: 'email', value: normalized } : null;
  }
  if (normalized.includes('@')) return null;
  const domain = normalizeAreaDomain(normalized);
  return domain ? { kind: 'domain', value: domain } : null;
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
  reason?: string | null;
  scanned?: number | null;
  inserted?: number | null;
  matched?: number | null;
  retired?: number | null;
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

/** Every Area is opt-in user data; there is no protected system default. */
export function areaCanArchive(_area?: { externalId?: string | null } | null): boolean {
  return true;
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
  // No grounded match means no suggestion. Having exactly one Area is not
  // evidence that this text belongs to it — the old "Only active area" fallback
  // was a coin flip dressed as a suggestion. The chooser handles it from here,
  // and "no Area" stays a valid answer.
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
  // A stale pointer — including one at the retired system Personal area — falls
  // through to the chooser. Resolving it onto whatever area happens to be named
  // "Personal" would silently put the user somewhere they never picked (#100).
  return { areaId: null, state: 'missing' };
}

export function areaIndexStatusSummary(status?: AreaIndexStatusLike | null): AreaIndexStatusSummary | null {
  if (!status) return null;
  const run = status.latestRun ?? null;
  const mail = status.mail ?? null;
  const scanned = Math.max(0, Math.floor(Number(run?.scanned ?? 0)));
  const matched = Math.max(0, Math.floor(Number(run?.matched ?? 0)));
  const mailboxTotal = Math.max(0, Math.floor(Number(mail?.total ?? 0)));
  const mailboxIndexing = Math.max(0, Math.floor(Number(mail?.indexing ?? 0)));
  const mailboxErrored = Math.max(0, Math.floor(Number(mail?.errored ?? 0)));
  const messagesSynced = Math.max(0, Math.floor(Number(mail?.messagesSynced ?? 0)));

  if (run?.status === 'queued') return { label: 'Area check queued', tone: 'active' };
  if (run?.status === 'running') {
    return {
      label: scanned ? `Checking areas · ${scanned.toLocaleString()} scanned` : 'Checking areas now',
      tone: 'active',
    };
  }
  if (run?.status === 'error') return { label: 'Area check needs retry', tone: 'warning' };
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
    // Report what was examined and what matched — never imply coverage. Most
    // mail matches no Area, and that is the expected outcome, so "N scanned ·
    // M linked" is the honest shape. "filed" is gone with the catch-all (#100).
    return {
      label: scanned
        ? `Areas checked · ${scanned.toLocaleString()} scanned · ${matched.toLocaleString()} linked`
        : 'Areas checked',
      tone: 'done',
    };
  }
  if (mailboxTotal > 0) return { label: 'Mail index ready', tone: 'done' };
  return { label: 'Waiting for mailbox index', tone: 'quiet' };
}

export function areaIndexStatusTitle(status?: AreaIndexStatusLike | null): string | null {
  const summary = areaIndexStatusSummary(status);
  if (!summary) return null;
  const run = status?.latestRun;
  if (!run) return summary.label;
  if (run.status === 'done' && summary.tone !== 'done') return summary.label;
  const scanned = Math.max(0, Math.floor(Number(run.scanned ?? 0)));
  const matched = Math.max(0, Math.floor(Number(run.matched ?? 0)));
  return `${run.reason || 'Area check'} · ${run.status} · ${scanned.toLocaleString()} scanned, ${matched.toLocaleString()} linked`;
}

// Fixed editorial order: the operational artifacts first (mail is the highest
// churn), the slow-moving context last. Sections always render — an empty
// section shows its own quiet empty state rather than vanishing, so the user
// learns what can be linked here.
export function areaHomeSections(counts: AreaHomeCountsLike): AreaHomeSection[] {
  return [
    { id: 'mail', label: 'Mail', count: counts.mail },
    { id: 'events', label: 'Events', count: counts.events },
    { id: 'tasks', label: 'Tasks', count: counts.tasks },
    { id: 'context', label: 'Context', count: counts.facts.verified + counts.facts.candidate },
  ];
}

// True when nothing has been linked at all — including connected or
// manual artifacts that do not render as mail/events/tasks. The page only uses
// its whole-Area empty explanation when every link kind is genuinely absent.
export function areaHasNoLinks(counts: AreaHomeCountsLike, otherLinks = 0): boolean {
  return counts.mail + counts.events + counts.tasks + Math.max(0, otherLinks) === 0;
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
  needsYouBounded?: boolean;
  upcoming: number;
  plans: number;
  projects: number;
  mail: number;
  tasks: number;
  candidateFacts: number;
  // True when any supporting evidence count fed in (mail/tasks/upcoming) is a
  // bounded preview rather than an exact total. The "filed signals" branch then
  // avoids an exact claim it can't stand behind.
  evidenceBounded?: boolean;
  upcomingBounded?: boolean;
}): string {
  if (input.needsYou > 0)
    return `${input.needsYouBounded ? 'at least ' : ''}${input.needsYou} ${input.needsYou === 1 ? 'item needs' : 'items need'} you before ${input.areaName} can move cleanly.`;
  if (input.upcoming > 0 && input.plans > 0)
    return `${input.upcomingBounded ? 'at least ' : ''}${input.upcoming} upcoming ${input.upcoming === 1 ? 'event' : 'events'} and ${input.plans} active ${input.plans === 1 ? 'plan' : 'plans'} are shaping ${input.areaName} today.`;
  if (input.plans > 0)
    return `${input.plans} active ${input.plans === 1 ? 'plan is' : 'plans are'} in motion for ${input.areaName}.`;
  const signals = input.mail + input.tasks + input.upcoming;
  if (signals > 0) {
    if (input.evidenceBounded)
      return `${input.areaName} has at least ${signals} filed ${signals === 1 ? 'signal' : 'signals'} to review.`;
    return `${input.areaName} has ${signals} filed ${signals === 1 ? 'signal' : 'signals'} to review.`;
  }
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

export type NeedsYouKind = 'work_input' | 'plan_answers' | 'overdue_task' | 'suggested_context';

export interface NeedsYouRow {
  id: string;
  kind: NeedsYouKind;
  title: string;
  detail: string | null;
  intentId?: string;
  workId?: string;
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
  return rows;
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

// ---------------------------------------------------------------------------
// Living brief presentation. The Convex read model (areaHome) returns the whole
// brief doc — status, lede, summary, generatedAt, error — so the page can be
// honest about generating/error/absent, not just render a perfect brief. These
// pure resolvers turn that doc into exactly what the lead should say, carrying
// the last-known text through transient generating/error states so the thesis
// never blinks out or fabricates progress.
// ---------------------------------------------------------------------------

export interface LivingBriefLike {
  status?: 'generating' | 'ready' | 'error' | string | null;
  lede?: string | null;
  summary?: string | null;
  generatedAt?: number | null;
  error?: string | null;
}

export type AreaBriefMode = 'ready' | 'generating' | 'error' | 'absent';

export interface AreaBriefState {
  mode: AreaBriefMode;
  // The editorial lead. Always present and never fabricated: for ready it is
  // the generated lede; otherwise it is the last-known lede if we have one,
  // else the deterministic headline the caller passes in.
  lede: string;
  // The supporting paragraph. Null when we have nothing real to show.
  summary: string | null;
  // A short, honest status note under the lead for non-ready modes. Null for
  // ready (freshness is shown separately) and when there is nothing to say.
  note: string | null;
  // True when lede/summary are carried over from a previous edition while the
  // current one is generating or errored — the UI dims them and shows `note`.
  stale: boolean;
  // Whether the primary affordance should offer to generate vs refresh.
  canGenerate: boolean;
  generatedAt: number | null;
}

function cleanBriefText(value?: string | null): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

// The single source of truth for what the brief lead renders. `headline` is the
// deterministic fallback (areaBriefHeadline) used only when there is no real
// generated text to show.
export function areaBriefState(brief: LivingBriefLike | null | undefined, headline: string): AreaBriefState {
  const lede = cleanBriefText(brief?.lede);
  const summary = cleanBriefText(brief?.summary);
  const hasText = lede.length > 0;
  const status = brief?.status ?? null;
  // A valid generatedAt marks a *published* prior edition. The backend's very
  // first generating/error record has no generatedAt and can carry placeholder
  // text — so text alone must not be mistaken for a real last brief to carry
  // over. Only a published edition is dimmed as stale with "showing the last
  // brief"; a first-ever run shows the deterministic headline instead.
  const rawGeneratedAt = brief?.generatedAt;
  const generatedDate = typeof rawGeneratedAt === 'number' ? new Date(rawGeneratedAt) : null;
  const generatedAt =
    typeof rawGeneratedAt === 'number' &&
    Number.isFinite(rawGeneratedAt) &&
    rawGeneratedAt > 0 &&
    generatedDate !== null &&
    Number.isFinite(generatedDate.getTime())
      ? rawGeneratedAt
      : null;
  const hasPriorEdition = generatedAt !== null && hasText;

  if (status === 'ready' && hasText) {
    return {
      mode: 'ready',
      lede,
      summary: summary || null,
      note: null,
      stale: false,
      canGenerate: false,
      generatedAt,
    };
  }
  if (status === 'generating') {
    return {
      mode: 'generating',
      lede: hasPriorEdition ? lede : headline,
      summary: hasPriorEdition ? summary || null : null,
      note: hasPriorEdition ? 'Updating the brief…' : 'Writing the brief…',
      stale: hasPriorEdition,
      canGenerate: false,
      generatedAt,
    };
  }
  if (status === 'error') {
    return {
      mode: 'error',
      lede: hasPriorEdition ? lede : headline,
      summary: hasPriorEdition ? summary || null : null,
      note: hasPriorEdition
        ? 'Couldn’t refresh — showing the last brief.'
        : 'Live work and evidence are below.',
      stale: hasPriorEdition,
      // A first-ever error has no published brief to show, so still offer to
      // generate one; a failed *refresh* keeps the prior edition and Refresh.
      canGenerate: !hasPriorEdition,
      generatedAt,
    };
  }
  // No brief doc yet, or a ready doc that somehow has no text: fall back to the
  // deterministic headline and offer to generate one. Never invent a summary.
  return {
    mode: 'absent',
    lede: hasText ? lede : headline,
    summary: hasText ? summary || null : null,
    note: null,
    stale: false,
    canGenerate: true,
    generatedAt,
  };
}

// A quiet, honest freshness string for a ready brief: "just now", "12m ago",
// "3h ago", else the calendar date. Null when there is no timestamp.
export function areaFreshness(
  generatedAt?: number | null,
  now = Date.now(),
  locale = 'en-US',
): string | null {
  if (typeof generatedAt !== 'number' || !Number.isFinite(generatedAt) || generatedAt <= 0) return null;
  const generatedDate = new Date(generatedAt);
  if (!Number.isFinite(generatedDate.getTime())) return null;
  const deltaMs = now - generatedAt;
  if (deltaMs < 0) return 'just now';
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(generatedDate);
}

// Work items whose agent is explicitly waiting on the user's answer. These fold
// into the single "Needs you" queue so there is one authoritative action region
// rather than a duplicate needs group inside Work.
export function workNeedsYouRows(
  rows?: Array<{
    _id: string;
    title?: string | null;
    rawText?: string | null;
    agentState?: string | null;
  }> | null,
): NeedsYouRow[] {
  const out: NeedsYouRow[] = [];
  for (const row of rows ?? []) {
    if (row?.agentState !== 'needs_input') continue;
    const title = cleanBriefText(row.title) || cleanBriefText(row.rawText) || 'Untitled work';
    out.push({
      id: `work:${row._id}`,
      kind: 'work_input',
      title,
      detail: 'Answer to continue this work',
      workId: String(row._id),
    });
  }
  return out;
}

// The single "Needs you" queue is assembled from two sources that can name the
// same thing: workNeedsYouRows (the agent is waiting → work_input) and
// areaNeedsYouRows (a plan needs answers → plan_answers). Because a Work item
// and its plan share one intent id, the same intent can surface as both. Merge
// by that shared identity, keeping the directly actionable work_input row and
// dropping the duplicate plan_answers. Rows with no shared identity — overdue
// tasks and suggested context — are always preserved. First-seen order is kept
// (pass workNeedsYouRows first so work_input wins the shared slot). Presentation
// may collapse this complete queue, but the data helper never silently drops an
// actionable item.
export function mergeNeedsYouRows(
  workRows: readonly NeedsYouRow[] | null | undefined,
  areaRows: readonly NeedsYouRow[] | null | undefined,
): NeedsYouRow[] {
  const sharedIntentKey = (row: NeedsYouRow): string | null => {
    if (row.kind === 'work_input') return row.workId ? `intent:${row.workId}` : null;
    if (row.kind === 'plan_answers') return row.intentId ? `intent:${row.intentId}` : null;
    return null;
  };
  const seen = new Set<string>();
  const out: NeedsYouRow[] = [];
  for (const row of [...(workRows ?? []), ...(areaRows ?? [])]) {
    const key = sharedIntentKey(row);
    if (key !== null) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(row);
  }
  return out;
}

export interface ProjectProgress {
  completed: number;
  total: number;
  percent: number;
  hasBar: boolean;
}

// Divide-by-zero-safe completion for a Project/Epic progress bar. Only produces
// a bar when there is a real task total; percent is clamped to 0–100.
export function projectProgress(completed?: number | null, total?: number | null): ProjectProgress {
  const totalN = Math.max(0, Math.floor(Number(total ?? 0)));
  const completedN = Math.min(totalN, Math.max(0, Math.floor(Number(completed ?? 0))));
  const percent = totalN > 0 ? Math.round((completedN / totalN) * 100) : 0;
  return { completed: completedN, total: totalN, percent, hasBar: totalN > 0 };
}

export type ProjectStateTone = 'active' | 'paused' | 'neutral';

// The state chip for a Project/Epic row. Real status only — no inferred health.
export function projectStateMeta(status?: string | null): { label: string; tone: ProjectStateTone } {
  switch (status) {
    case 'active':
      return { label: 'Active', tone: 'active' };
    case 'paused':
      return { label: 'Paused', tone: 'paused' };
    case 'done':
      return { label: 'Done', tone: 'neutral' };
    case 'archived':
      return { label: 'Archived', tone: 'neutral' };
    default:
      return { label: status ? status.replaceAll('_', ' ') : 'Project', tone: 'neutral' };
  }
}

// A bounded preview count: `shown` is how many rows the read model returned;
// `hasMore` is true when the area owns more than were shown (the total is not
// known here, only that it exceeds the preview). Facts remain exact totals.
export interface EvidencePreview {
  shown: number;
  hasMore: boolean;
}

export interface EvidenceCountsLike {
  mail: EvidencePreview;
  events: EvidencePreview;
  tasks: EvidencePreview;
  facts: { verified: number; candidate: number };
}

// The one-line rollup above the supporting Evidence band: only non-zero facets,
// in a fixed order, so a noisy mailbox is summarized rather than dumped. Mail,
// events, and tasks are bounded previews — when more exist than were shown, the
// label reads "30+ threads" (honest about the cap) rather than a false exact
// total. Facts are exact. Empty array when the area has no evidence yet (the
// band then hides).
export function evidenceRollup(counts: EvidenceCountsLike): AreaPulseSegment[] {
  const segments: AreaPulseSegment[] = [];
  const pushPreview = (id: string, preview: EvidencePreview, one: string, many: string) => {
    const n = Math.max(0, Math.floor(Number(preview?.shown ?? 0)));
    if (n <= 0) return;
    const noun = n === 1 && !preview.hasMore ? one : many;
    segments.push({ id, label: preview.hasMore ? `${n}+ ${noun}` : `${n} ${noun}` });
  };
  const pushExact = (id: string, n: number, one: string, many: string) => {
    if (n > 0) segments.push({ id, label: `${n} ${n === 1 ? one : many}` });
  };
  pushPreview('mail', counts.mail, 'thread', 'threads');
  pushPreview('events', counts.events, 'event', 'events');
  pushPreview('tasks', counts.tasks, 'task', 'tasks');
  pushExact('verified', counts.facts.verified, 'verified fact', 'verified facts');
  pushExact('candidate', counts.facts.candidate, 'context ask', 'context asks');
  return segments;
}

// Places are supporting evidence too, even when an Area has no linked
// mail/events/tasks/context yet. Keep this gate pure so the only-places state
// cannot disappear behind the artifact rollup condition again.
export function shouldShowEvidenceBand(evidenceSegments: number, places: number): boolean {
  return evidenceSegments > 0 || places > 0;
}
