// Needs you, part 2 (docs/needs-you.md, "Part 2: rules decide the message").
// Jev gives the probabilities; these rules turn one assessment into the
// obligations of one thread. Pure: Convex (convex/obligations.ts) and the
// tests run the same code. Jev writes no text, so every line here comes from
// the source: the subject, the evidence message, and fixed copy.

import { addDays } from 'date-fns';
import { assessmentDue, type JevAssessment, routineNoticeProbability } from '../jev/contract';
import { isVipSender } from '../notifications/mail-push';
import { emailFromHeader } from '../shared/format';
import { parseIsoInTimezone } from '../shared/timezones';
import {
  CHANGE_AUTO_CLOSE_MS,
  CHANGE_NOW_WINDOW_MS,
  OBLIGATION_SOURCE_LABELS,
  type ObligationDue,
  type ObligationKind,
  type ObligationSource,
  PUSH_PROBABILITY,
  type PushLevel,
} from './contract';

/** One message of the thread, as Jev read it (oldest to newest). */
export interface ObligationSourceMessage {
  id: string;
  from: string;
  to?: string;
  subject?: string;
  body: string;
  date: number;
}

export interface MailThreadFacts {
  accountId: string;
  threadId: string;
  subject: string;
  messages: ObligationSourceMessage[];
  /** The mailbox addresses of the user, lower case. */
  selfAddresses: string[];
  /** The Albatross that this thread belongs to, when one is known. */
  workId?: string;
}

export interface MailObligationSettings {
  vipSenders: string[];
  timezone: string;
  /** The Albatrosses that the user used in the last 7 days. */
  recentWorkIds?: string[];
  /** A Jev correction (Not mine) excludes the thread or its sender. */
  excluded?: boolean;
  /** The probability that a push needs. The default is PUSH_PROBABILITY. */
  pushProbability?: number;
  /**
   * The 30-day fill (phase 1.1): the rows open in-app only, and no row is
   * time-sensitive, however new its source is.
   */
  fill?: boolean;
}

/** One obligation that a thread wants, before it is stored. */
export interface WantedObligation {
  kind: ObligationKind;
  title: string;
  asker: string;
  askerAddress?: string;
  why: string;
  excerpt?: string;
  due: ObligationDue;
  dueAt?: number;
  probability: number;
  pushLevel: PushLevel;
  /** The evidence message: the reply anchor and the deep link. Mail and codes only. */
  messageId?: string;
  workId?: string;
  /** The time of the source message or item. The age rules of a change read it. */
  sourceAt?: number;
  /** Where in the source ("#release", "LAB-212", the meeting title). */
  sourceLabel?: string;
  /** An https link that opens the item in its own app. */
  url?: string;
  /** Calendar items: the event (the series for a repeated event), its calendar, and its start. */
  eventId?: string;
  calendarId?: string;
  eventStart?: number;
}

const TITLE_CHARS = 160;
const EXCERPT_CHARS = 400;
const SOON_MS = 3 * 86_400_000;

/**
 * Phase 1.1: a change is time-sensitive only when it is new and it reports a
 * problem. A problem is a failed payment, a cancelled or moved booking, or a
 * locked account or a revoked credential. These cues find the problem in the
 * subject and the start of the evidence, by the subject kind of the verdict.
 */
const PROBLEM_CUES: Record<string, RegExp> = {
  finance:
    /\b(fail(?:ed|ure|s)?|declined?|unsuccessful|past due|overdue|insufficient funds|bounced|payment (?:problem|issue)|(?:could ?n[o']?t|unable to|did not|didn't) (?:be )?(?:process|charge|collect|complete)\w*)\b/i,
  booking:
    /\b(cancel(?:l?ed|lation|s)|resched\w*|moved|postponed|delayed|now departs|new (?:time|date)|time (?:has )?changed|no longer (?:available|scheduled|takes place)|rebooked|diverted)\b/i,
  account:
    /\b(lock(?:ed)?|suspend(?:ed)?|disabled|revoked|deactivated|compromised|unauthori[sz]ed|terminated|banned|blocked|restricted|expired)\b/i,
};

/**
 * Phase 1.1 cues of a routine notice: terms, privacy, and policy updates,
 * renewal and billing reminders, and feature news. Only a verdict without the
 * `routine_notice` answer (stored before the question existed) reads them.
 */
const ROUTINE_CUE =
  /\b(terms of (?:service|use)|terms and conditions|privacy (?:policy|notice|statement)|(?:services?|user|cardholder|customer|account) agreement|(?:updat\w*|chang\w*) (?:to )?(?:our|the|your) (?:terms|policies|policy|agreement|privacy)|policy updates?|will (?:automatically )?renew|renews? (?:on|soon)|renewal (?:notice|reminder)|auto-?renew\w*|new features?|introducing|what's new|service (?:notice|announcement)|billing reminder|statement is (?:ready|available))\b/i;

/** A `routine_notice` answer at or above this value drops the notice. */
export const ROUTINE_NOTICE_HIGH = 0.75;

/** The start of the evidence that the cues read: the opening, not the footer. */
function cueText(subject: string, evidence: string) {
  return `${subject}\n${clip(ownText(evidence) || evidence, 600)}`;
}

/** True when the subject and the evidence of a change name a problem of its subject kind. */
export function changeIsProblem(subjectKind: string, subject: string, evidence: string): boolean {
  const cue = PROBLEM_CUES[subjectKind];
  return Boolean(cue?.test(cueText(subject, evidence)));
}

function anyProblem(text: string) {
  return Object.values(PROBLEM_CUES).some((cue) => cue.test(text));
}

/**
 * True when the latest inbound message is a routine notice: a terms,
 * privacy, or policy update, a renewal or billing reminder, or a feature
 * announcement with no problem to fix (phase 1.1). Jev answers the
 * `routine_notice` question. A verdict from before the question reads the
 * routine cues of the subject and the evidence, and a problem cue cancels
 * them.
 */
export function isRoutineNotice(assessment: JevAssessment, subject: string): boolean {
  const probability = routineNoticeProbability(assessment);
  if (probability !== undefined) return probability >= ROUTINE_NOTICE_HIGH;
  const text = cueText(subject, assessment.changeEvidence?.text ?? '');
  return ROUTINE_CUE.test(text) && !anyProblem(text);
}

/** Cuts text at a word end and adds an ellipsis when it is too long. */
export function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

/** The display name of a header ("Maya Chen <maya@x.test>"), or its address. */
export function headerName(header: string | undefined): string {
  const raw = String(header || '').trim();
  const named = raw.match(/^\s*"?([^"<]*?)"?\s*<[^>]*>/);
  const name = named?.[1]?.trim();
  if (name) return name;
  return emailFromHeader(raw) || raw || 'Someone';
}

function firstAddress(list: string | undefined, self: Set<string>): string | undefined {
  for (const part of String(list || '').split(/[,;]/)) {
    const email = emailFromHeader(part);
    if (email && !self.has(email)) return part.trim();
  }
  return undefined;
}

/**
 * The text that the user wrote or read in one message: no quoted lines, no
 * earlier message below "On ... wrote:", and no signature.
 */
export function ownText(body: string): string {
  const lines: string[] = [];
  for (const line of String(body || '').split(/\r?\n/)) {
    if (/^\s*>/.test(line)) continue;
    if (/^\s*(--|__)\s*$/.test(line)) break;
    if (/^\s*On .{4,200}wrote:\s*$/i.test(line)) break;
    if (/^\s*-{2,}\s*(Original|Forwarded) Message/i.test(line)) break;
    lines.push(line);
  }
  return lines.join('\n').trim();
}

function sentences(text: string): string[] {
  return ownText(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.replace(/\s+/g, ' ').trim())
    .filter((sentence) => sentence.length >= 8 && /[a-z]/i.test(sentence));
}

const REQUEST_CUE =
  /\b(please|can you|could you|would you|will you|let me know|need you|needs you|confirm|approve|review|sign|send|reply|respond|upload|pay|submit|complete)\b/i;
const PROMISE_CUE = /\b(i will|i'll|we will|we'll|i am going to|we are going to|will send|will get back)\b/i;
const CHANGE_CUE =
  /\b(cancel(?:l?ed)?|moved|changed|reschedul\w*|delayed|failed|declined|overdue|locked|suspended|now departs|new time)\b/i;

/** The sentence of the evidence that says what is owed, or undefined. */
export function requestLine(text: string, kind: ObligationKind): string | undefined {
  const all = sentences(text);
  const find = (test: (sentence: string) => boolean) => all.find(test);
  const pick =
    kind === 'waiting'
      ? find((sentence) => PROMISE_CUE.test(sentence) || sentence.endsWith('?'))
      : kind === 'reply'
        ? (find((sentence) => sentence.endsWith('?')) ?? find((sentence) => REQUEST_CUE.test(sentence)))
        : kind === 'change'
          ? find((sentence) => CHANGE_CUE.test(sentence))
          : find((sentence) => REQUEST_CUE.test(sentence) || PROMISE_CUE.test(sentence));
  return pick ? clip(pick, TITLE_CHARS) : undefined;
}

function subjectOf(subject: string) {
  return clip(subject.replace(/^\s*((re|fwd?|aw|wg)\s*:\s*)+/i, '').trim() || '(no subject)', 120);
}

/** The line when the evidence has no clear request sentence. */
export function fallbackTitle(kind: ObligationKind, subject: string): string {
  const topic = subjectOf(subject);
  if (kind === 'reply') return `Reply about ${topic}`;
  if (kind === 'action') return `Action needed: ${topic}`;
  if (kind === 'waiting') return `Waiting for an answer: ${topic}`;
  if (kind === 'change') return `Changed: ${topic}`;
  return `Sign-in code: ${topic}`;
}

const CHANGE_TOPICS: Record<string, string> = {
  finance: 'a payment or a bill',
  booking: 'a booking',
  account: 'an account',
  order: 'an order',
};

/** "Why this needs you": one fixed sentence for each kind. */
export function whyLine(kind: ObligationKind, asker: string, subjectKind?: string): string {
  if (kind === 'reply')
    return `${asker} asked you something that is still open. No reply from you came after it.`;
  if (kind === 'action') return `This thread asks you to do something that is not done yet.`;
  if (kind === 'waiting') return `You wait for ${asker}. No answer is in the thread yet.`;
  if (kind === 'change')
    return `${asker} reports a change to ${CHANGE_TOPICS[subjectKind || ''] || 'something you have'}.`;
  return `${asker} sent a sign-in code. This closes when you use the code or when it expires.`;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sept: 9,
  sep: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};
const MONTH = Object.keys(MONTHS).join('|');
const WEEKDAY = WEEKDAYS.join('|');
const CUE = '(?:by|before|until|due|on|no later than|deadline(?: is)?)';

function usableZone(timezone: string) {
  if (!timezone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0);
    return timezone;
  } catch {
    return 'UTC';
  }
}

function localDate(epoch: number, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(epoch));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  // Noon UTC of the local date: whole-day arithmetic never crosses a date line.
  return new Date(Date.UTC(get('year'), get('month') - 1, get('day'), 12));
}

function ymd(date: Date) {
  return date.toISOString().slice(0, 10);
}

/**
 * A concrete due time for plain phrases in the evidence: "today", "tomorrow",
 * a weekday ("by Friday"), "the end of the week", or a date ("by October
 * 31"). It is the end of that day in the user's zone. `now` is the reference
 * time: give the date of the evidence message, so "by Friday" means the Friday
 * after that message. It gives undefined when Jev says `none`, when no phrase
 * matches, when two phrases name different days, or when a phrase is unclear
 * ("next Friday").
 */
export function dueAtFromEvidence(
  text: string,
  due: ObligationDue,
  timezone: string,
  now: number,
): number | undefined {
  if (due === 'none') return undefined;
  const zone = usableZone(timezone);
  const source = ownText(text).toLowerCase();
  if (!source) return undefined;
  const reference = localDate(now, zone);
  const found = new Set<string>();
  let unclear = false;
  if (
    /\b(today|tonight|this (?:morning|afternoon|evening)|end of (?:the )?day|eod|close of business|cob)\b/.test(
      source,
    )
  )
    found.add(ymd(reference));
  if (/\btomorrow\b/.test(source)) found.add(ymd(addDays(reference, 1)));
  if (new RegExp(`\\bnext (?:${WEEKDAY})\\b`).test(source)) unclear = true;
  for (const match of source.matchAll(new RegExp(`\\b(?:${CUE}|this)\\s+(${WEEKDAY})\\b`, 'g'))) {
    const offset = (WEEKDAYS.indexOf(match[1]) - reference.getUTCDay() + 7) % 7;
    found.add(ymd(addDays(reference, offset)));
  }
  if (/\b(?:end of (?:the |this )?week|eow)\b/.test(source)) {
    const offset = 5 - reference.getUTCDay();
    if (offset >= 0) found.add(ymd(addDays(reference, offset)));
    else unclear = true;
  }
  const dates = [
    ...[
      ...source.matchAll(
        new RegExp(
          `\\b${CUE}\\s+(?:(?:${WEEKDAY}),?\\s+)?(${MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`,
          'g',
        ),
      ),
    ].map((match) => [MONTHS[match[1]], Number(match[2])] as const),
    ...[
      ...source.matchAll(
        new RegExp(`\\b${CUE}\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH})\\b`, 'g'),
      ),
    ].map((match) => [MONTHS[match[2]], Number(match[1])] as const),
  ];
  for (const [month, day] of dates) {
    let year = reference.getUTCFullYear();
    let date = new Date(Date.UTC(year, month - 1, day, 12));
    if (date.getUTCMonth() !== month - 1) {
      unclear = true;
      continue;
    }
    // A date before the message is in the next year ("by January 5" in December).
    if (date.getTime() < reference.getTime()) {
      year += 1;
      date = new Date(Date.UTC(year, month - 1, day, 12));
    }
    found.add(ymd(date));
  }
  if (unclear || found.size !== 1) return undefined;
  const [day] = [...found];
  return parseIsoInTimezone(`${day}T23:59:59`, zone, 'dueAt') + 999;
}

/** The start of the local day of `now` in the zone (UTC for an unknown zone). */
export function startOfLocalDay(now: number, timezone: string): number {
  const zone = usableZone(timezone);
  return parseIsoInTimezone(`${ymd(localDate(now, zone))}T00:00:00`, zone, 'dayStart');
}

function evidenceMessage(facts: MailThreadFacts, messageId: string) {
  return facts.messages.find((message) => message.id === messageId) ?? facts.messages.at(-1);
}

/** The person or service to name for an obligation, and their address. */
function askerOf(message: ObligationSourceMessage | undefined, self: Set<string>) {
  const fromEmail = emailFromHeader(message?.from);
  const ownMessage = Boolean(fromEmail && self.has(fromEmail));
  // A message by the user (a request it sent, or its own promise) names the
  // other person: the first recipient that is not the user.
  const header = (ownMessage && firstAddress(message?.to, self)) || message?.from;
  return { asker: headerName(header), askerAddress: emailFromHeader(header) || undefined };
}

/**
 * The obligations that one Jev assessment of one thread wants. It follows the
 * rule table in docs/needs-you.md:
 *
 * - A promotion or a newsletter gives none. A thread that a correction
 *   excludes (Not mine) gives none.
 * - `reply` and `action` push (normal) when the asker is a person and the
 *   item is due today or soon, the sender is a VIP, or the item belongs to an
 *   Albatross that the user used in the last 7 days. Otherwise they are
 *   in-app only.
 * - `change` with a finance, booking, or account subject pushes at the
 *   time-sensitive level. Another change is in-app only.
 * - `waiting` is in-app only.
 * - A kind in the uncertain band is not in `assessment.obligations` (Jev
 *   keeps only clear kinds with evidence), so it gives none.
 *
 * Each push also needs the probability of the push bar (PUSH_PROBABILITY).
 */
export function mailObligations(
  assessment: JevAssessment,
  facts: MailThreadFacts,
  settings: MailObligationSettings,
  now: number,
): WantedObligation[] {
  if (settings.excluded) return [];
  if (assessment.purpose === 'promotion' || assessment.purpose === 'newsletter') return [];
  const self = new Set(facts.selfAddresses.map((address) => address.toLowerCase()));
  const bar = settings.pushProbability ?? PUSH_PROBABILITY;
  const due = assessmentDue(assessment);
  const person = assessment.purpose === 'conversation';
  const workRecent = Boolean(facts.workId && (settings.recentWorkIds || []).includes(facts.workId));
  // Phase 1.1: a routine notice never opens a change or an action.
  const routine = isRoutineNotice(assessment, facts.subject);
  const wanted: WantedObligation[] = [];
  const build = (
    kind: ObligationKind,
    evidence: { messageId: string; text: string },
    probability: number,
  ): WantedObligation => {
    const message = evidenceMessage(facts, evidence.messageId);
    const { asker, askerAddress } = askerOf(message, self);
    const dueAt = dueAtFromEvidence(evidence.text, due, settings.timezone, message?.date ?? now);
    const excerpt = clip(ownText(evidence.text) || evidence.text, EXCERPT_CHARS);
    return {
      kind,
      title: requestLine(evidence.text, kind) ?? fallbackTitle(kind, facts.subject),
      asker,
      ...(askerAddress ? { askerAddress } : {}),
      why: whyLine(kind, asker, assessment.subjectKind),
      ...(excerpt ? { excerpt } : {}),
      due,
      ...(dueAt !== undefined ? { dueAt } : {}),
      probability,
      pushLevel: 'none',
      messageId: message?.id ?? evidence.messageId,
      ...(facts.workId ? { workId: facts.workId } : {}),
      sourceAt: message?.date ?? now,
    };
  };
  for (const obligation of assessment.obligations) {
    if (routine && obligation.kind === 'action') continue;
    const item = build(obligation.kind, obligation.evidence, obligation.probability);
    if (obligation.kind !== 'waiting' && person && obligation.probability >= bar) {
      const dueSoon =
        due === 'today' || due === 'soon' || (item.dueAt !== undefined && item.dueAt <= now + SOON_MS);
      const vip = isVipSender(item.askerAddress, settings.vipSenders);
      if (dueSoon || vip || workRecent) item.pushLevel = 'normal';
    }
    wanted.push(item);
  }
  if (assessment.meaningfulChange && assessment.changeEvidence && !routine) {
    const probability = assessment.probabilities.change ?? 1;
    const item = build('change', assessment.changeEvidence, probability);
    const age = now - (item.sourceAt ?? now);
    // A change older than CHANGE_AUTO_CLOSE_MS has aged out: it does not open.
    if (age < CHANGE_AUTO_CLOSE_MS) {
      if (
        !settings.fill &&
        age < CHANGE_NOW_WINDOW_MS &&
        probability >= bar &&
        changeIsProblem(assessment.subjectKind, facts.subject, assessment.changeEvidence.text)
      )
        item.pushLevel = 'time_sensitive';
      wanted.push(item);
    }
  }
  return wanted;
}

/** The fields of a recorded one-time code that its obligation reads. */
export interface CodeFacts {
  messageId: string;
  from: string;
  subject: string;
  issuer?: string;
  label?: string;
  confidence: number;
  expiresAt: number;
}

/**
 * A one-time code is an obligation of kind `code`: it pushes at once at the
 * time-sensitive level, and quiet hours and the hourly limit never hold it.
 */
export function codeObligation(code: CodeFacts): WantedObligation {
  const asker = clip(code.issuer?.trim() || headerName(code.from), 80);
  const askerAddress = emailFromHeader(code.from) || undefined;
  return {
    kind: 'code',
    title: `Sign-in code for ${asker}`,
    asker,
    ...(askerAddress ? { askerAddress } : {}),
    why: whyLine('code', asker),
    excerpt: clip(code.subject || code.label || 'Sign-in code', EXCERPT_CHARS),
    due: 'today',
    dueAt: code.expiresAt,
    probability: Math.max(0, Math.min(1, code.confidence)),
    pushLevel: 'time_sensitive',
    messageId: code.messageId,
  };
}

// ---------------------------------------------------------------------------
// Connected sources (phase 2): Slack, Atlassian, Granola, Drive, GitHub, and
// Bitbucket. Jev labels each content item (lib/content/intelligence.ts); an
// actionable item that is not resolved is an `action` of the owner.
// ---------------------------------------------------------------------------

/** A content item older than this opens no obligation (the same window as the mail fill). */
export const CONTENT_OBLIGATION_WINDOW_MS = 30 * 86_400_000;
/** A probability at or above this opens an item. The noulHigh of Jev 1.13. */
export const OPEN_PROBABILITY = 0.75;

/** The obligation source of a content index source, or undefined for mail, attachments, and documents. */
export function contentObligationSource(source: string): ObligationSource | undefined {
  switch (source) {
    case 'slack':
      return 'slack';
    case 'jira':
    case 'atlassian':
      return 'atlassian';
    case 'granola':
      return 'granola';
    case 'google_drive':
    case 'onedrive':
      return 'drive';
    case 'github':
      return 'github';
    case 'bitbucket':
      return 'bitbucket';
    default:
      return undefined;
  }
}

/**
 * What the GitHub and Bitbucket loaders know about the owner and one item
 * (lib/mcp/sync.ts). The content text says it in words, so Jev can classify
 * the item for the owner.
 */
export type OwnerFact = 'review_requested' | 'mentioned' | 'assigned' | 'checks_failed' | 'authored';

const OWNER_FACT_LINES: Record<OwnerFact, string> = {
  review_requested: 'A review of this pull request is requested from the owner.',
  mentioned: 'The owner is mentioned in this item.',
  assigned: 'This item is assigned to the owner.',
  checks_failed: "Checks failed on the owner's branch.",
  authored: 'The owner opened this item.',
};

const OWNER_FACT_TITLES: Partial<Record<OwnerFact, string>> = {
  checks_failed: 'Fix the failed checks',
  review_requested: 'Review',
  assigned: 'Assigned to you',
  mentioned: 'Mentioned',
};

/** The known owner facts in a stored list, in a fixed order. Unknown values are left out. */
export function ownerFacts(value: unknown): OwnerFact[] {
  const list = Array.isArray(value) ? value : [];
  return (Object.keys(OWNER_FACT_LINES) as OwnerFact[]).filter((fact) => list.includes(fact));
}

/** The owner facts as sentences for the content text. */
export function ownerFactText(value: unknown): string {
  return ownerFacts(value)
    .map((fact) => OWNER_FACT_LINES[fact])
    .join('\n');
}

/** The content labels that the rules read (lib/content/contract.ts). */
export interface ContentLabelFacts {
  kind: string;
  actionable: boolean;
  resolved: boolean;
  workId: string | null;
  due?: ObligationDue;
  actionableProbability?: number;
}

/** One content item, with the facts of its source row. */
export interface ContentItemFacts {
  /** The content index source ("slack", "jira", "google_drive", ...). */
  source: string;
  title: string;
  text: string;
  url?: string;
  modifiedAt: number;
  deleted: boolean;
  /** The person who wrote the item, from the source row. */
  author?: string;
  /** Where in the source: a channel, an issue key, a repository and number. */
  sourceLabel?: string;
  ownerFacts?: OwnerFact[];
}

/** The connector row of one content item (convex/schema.ts `mcpItems`), as the rules read it. */
export interface ConnectorRowFacts {
  externalId: string;
  kind?: string;
  author?: string;
  repository?: string;
  raw?: any;
}

/** Where in the source an item is: "#release", "LAB-212", "northwind/web #482", a meeting or file title. */
export function connectorSourceLabel(
  source: string,
  title: string,
  row?: ConnectorRowFacts,
): string | undefined {
  const raw = row?.raw && typeof row.raw === 'object' ? row.raw : {};
  if (source === 'slack')
    return raw.directMessage ? 'Direct message' : raw.channelName ? `#${raw.channelName}` : 'Slack';
  if (source === 'jira') return typeof raw.key === 'string' && raw.key ? raw.key : undefined;
  if (source === 'github') {
    const match = /^github:[a-z_]+:(.+)#(\d+)$/.exec(row?.externalId || '');
    return match ? `${match[1]} #${match[2]}` : row?.repository;
  }
  if (source === 'bitbucket') {
    const repository = raw.destination?.repository?.full_name || raw.source?.repository?.full_name;
    return repository && raw.id !== undefined ? `${repository} #${raw.id}` : repository || undefined;
  }
  return title || undefined;
}

/** The rule facts of one content item and its connector row. */
export function contentItemFacts(
  item: { source: string; title: string; text: string; url?: string; modifiedAt: number; deleted: boolean },
  row?: ConnectorRowFacts,
): ContentItemFacts {
  const raw = row?.raw && typeof row.raw === 'object' ? row.raw : {};
  const facts = ownerFacts(raw.ownerFacts);
  const label = connectorSourceLabel(item.source, item.title, row);
  return {
    source: item.source,
    title: item.title,
    text: item.text,
    ...(item.url ? { url: item.url } : {}),
    modifiedAt: item.modifiedAt,
    deleted: item.deleted,
    ...(row?.author ? { author: row.author } : {}),
    ...(label ? { sourceLabel: label } : {}),
    ...(facts.length ? { ownerFacts: facts } : {}),
  };
}

function httpsUrl(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The `action` that one labelled content item wants, or null. It follows the
 * rule table of docs/needs-you.md: an item that Jev labels actionable for the
 * owner, and not resolved, is an action. It pushes by the same rules as a
 * mail action: the asker is a person, the item passes the push bar, and it
 * is due today or soon, the asker is a VIP, or the item belongs to an
 * Albatross that the user used in the last 7 days. Noise, a deleted item, an
 * item older than CONTENT_OBLIGATION_WINDOW_MS, and an item that a Not mine
 * excludes give none.
 */
export function contentObligation(
  item: ContentItemFacts,
  labels: ContentLabelFacts,
  settings: MailObligationSettings,
  now: number,
): WantedObligation | null {
  const source = contentObligationSource(item.source);
  if (!source || settings.excluded || item.deleted) return null;
  if (!labels.actionable || labels.resolved || labels.kind === 'noise') return null;
  if (now - item.modifiedAt > CONTENT_OBLIGATION_WINDOW_MS) return null;
  const sourceName = OBLIGATION_SOURCE_LABELS[source];
  const author = item.author?.trim();
  const asker = clip(author || sourceName, 80);
  const askerAddress = emailFromHeader(author) || undefined;
  const due = labels.due ?? 'none';
  const dueAt = dueAtFromEvidence(item.text, due, settings.timezone, item.modifiedAt);
  const probability = labels.actionableProbability ?? PUSH_PROBABILITY;
  const facts = item.ownerFacts ?? [];
  const lead = facts.map((fact) => OWNER_FACT_TITLES[fact]).find(Boolean);
  const topic = clip(item.title || sourceName, 120);
  // The content text starts with the item title: the request is in the body.
  const body =
    item.title && item.text.startsWith(item.title) ? item.text.slice(item.title.length) : item.text;
  const title = lead ? `${lead}: ${topic}` : (requestLine(body, 'action') ?? `Action needed: ${topic}`);
  const workId = labels.workId && !labels.workId.startsWith('proposal:') ? labels.workId : undefined;
  const excerpt = clip(item.text, EXCERPT_CHARS);
  const wanted: WantedObligation = {
    kind: 'action',
    title: clip(title, TITLE_CHARS),
    asker,
    ...(askerAddress ? { askerAddress } : {}),
    why: `This ${sourceName} item asks you to do something that is not done yet.`,
    ...(excerpt ? { excerpt } : {}),
    due,
    ...(dueAt !== undefined ? { dueAt } : {}),
    probability,
    pushLevel: 'none',
    ...(workId ? { workId } : {}),
    sourceAt: item.modifiedAt,
    ...(item.sourceLabel ? { sourceLabel: clip(item.sourceLabel, 120) } : {}),
    ...(httpsUrl(item.url) ? { url: httpsUrl(item.url) } : {}),
  };
  // Drive and Granola name no person who asked: their items are in-app only.
  const person = source !== 'drive' && source !== 'granola';
  const bar = settings.pushProbability ?? PUSH_PROBABILITY;
  if (!settings.fill && person && probability >= bar) {
    const dueSoon = due === 'today' || due === 'soon' || (dueAt !== undefined && dueAt <= now + SOON_MS);
    const vip = isVipSender(askerAddress, settings.vipSenders);
    const workRecent = Boolean(workId && (settings.recentWorkIds || []).includes(workId));
    if (dueSoon || vip || workRecent) wanted.pushLevel = 'normal';
  }
  return wanted;
}

// ---------------------------------------------------------------------------
// Calendar (phase 4): invitations without an answer (`rsvp`), and meetings
// in the next 24 hours that need preparation (`prepare`).
// ---------------------------------------------------------------------------

/** An invitation opens an `rsvp` item when its event starts in this window. */
export const RSVP_WINDOW_MS = 14 * 86_400_000;
/** Jev asks the `prepare` question for events that start in this window. */
export const PREPARE_WINDOW_MS = 24 * 3_600_000;
/** A closed row stays this long, then the sweep removes it. */
export const CLOSED_RETENTION_MS = 30 * 86_400_000;

export interface CalendarPerson {
  email?: string;
  name?: string;
  /** Participants: yes, no, maybe, or noreply. */
  status?: string;
}

/** One calendar event row (convex/schema.ts `calendarEvents`), as the rules read it. */
export interface CalendarEventFacts {
  accountId: string;
  providerCalendarId: string;
  providerEventId: string;
  masterEventId?: string;
  title: string;
  description?: string;
  location?: string;
  status?: string;
  startAt: number;
  endAt: number;
  allDay?: boolean;
  organizer?: CalendarPerson | null;
  participants?: CalendarPerson[] | null;
  htmlLink?: string;
}

/** The event that an item names: the series of a repeated event, else the event. */
export function calendarEventId(event: Pick<CalendarEventFacts, 'providerEventId' | 'masterEventId'>) {
  return event.masterEventId || event.providerEventId;
}

/** The source key of one calendar item: `calendar:<accountId>:<eventId>`. */
export function calendarSourceKey(accountId: string, eventId: string) {
  return `calendar:${accountId}:${eventId}`;
}

function personEmail(person: CalendarPerson | null | undefined) {
  return String(person?.email || '')
    .trim()
    .toLowerCase();
}

function personName(person: CalendarPerson | null | undefined) {
  return String(person?.name || '').trim() || personEmail(person);
}

/** The owner's own participant row, by the mailbox addresses. */
export function ownParticipant(
  event: Pick<CalendarEventFacts, 'participants'>,
  selfAddresses: readonly string[],
): CalendarPerson | undefined {
  const self = new Set(selfAddresses.map((address) => address.toLowerCase()));
  return (event.participants || []).find((person) => self.has(personEmail(person)));
}

/** The other people of an event: participants that are not the owner and not a room. */
export function otherPeople(
  event: Pick<CalendarEventFacts, 'participants' | 'organizer'>,
  selfAddresses: readonly string[],
): CalendarPerson[] {
  const self = new Set(selfAddresses.map((address) => address.toLowerCase()));
  return (event.participants || []).filter((person) => {
    const email = personEmail(person);
    return email && !self.has(email) && !/resource\.calendar\.google\.com$/.test(email);
  });
}

function cancelled(event: Pick<CalendarEventFacts, 'status'>) {
  return /^cancel/i.test(String(event.status || ''));
}

function eventDue(startAt: number, now: number): ObligationDue {
  if (startAt - now <= PREPARE_WINDOW_MS) return 'today';
  if (startAt - now <= SOON_MS) return 'soon';
  return 'later';
}

/**
 * The `rsvp` item of one event, or null: an invitation from another person
 * that still waits for the owner's answer, for an event that starts in the
 * next 14 days. It is in-app only: the invitation mail is the first notice.
 */
export function rsvpObligation(
  event: CalendarEventFacts,
  selfAddresses: readonly string[],
  now: number,
): WantedObligation | null {
  if (cancelled(event) || event.startAt <= now || event.startAt > now + RSVP_WINDOW_MS) return null;
  const organizerEmail = personEmail(event.organizer);
  const self = new Set(selfAddresses.map((address) => address.toLowerCase()));
  if (!organizerEmail || self.has(organizerEmail)) return null;
  const own = ownParticipant(event, selfAddresses);
  if (!own || (own.status && own.status !== 'noreply')) return null;
  const asker = clip(personName(event.organizer), 80);
  const title = clip(event.title || '(no title)', 120);
  const url = httpsUrl(event.htmlLink);
  return {
    kind: 'rsvp',
    title: `Answer the invitation: ${title}`,
    asker,
    askerAddress: organizerEmail,
    why: `${asker} invited you. You have not answered yet.`,
    ...(event.description ? { excerpt: clip(event.description, EXCERPT_CHARS) } : {}),
    due: eventDue(event.startAt, now),
    dueAt: event.startAt,
    probability: 1,
    pushLevel: 'none',
    sourceAt: event.startAt,
    sourceLabel: title,
    ...(url ? { url } : {}),
    eventId: calendarEventId(event),
    calendarId: event.providerCalendarId,
    eventStart: event.startAt,
  };
}

/**
 * True when Jev must ask the `prepare` question about an event: it starts in
 * the next 24 hours, it is not cancelled or all-day, other people attend,
 * and the owner did not decline.
 */
export function prepareCandidate(
  event: CalendarEventFacts,
  selfAddresses: readonly string[],
  now: number,
): boolean {
  if (cancelled(event) || event.allDay) return false;
  if (event.startAt <= now || event.startAt > now + PREPARE_WINDOW_MS) return false;
  if (!otherPeople(event, selfAddresses).length) return false;
  return ownParticipant(event, selfAddresses)?.status !== 'no';
}

/**
 * The `prepare` item of one event after Jev's answer, or null below
 * OPEN_PROBABILITY. Other people attend, so it pushes at the push bar.
 */
export function prepareObligation(
  event: CalendarEventFacts,
  probability: number,
  selfAddresses: readonly string[],
  settings: Pick<MailObligationSettings, 'pushProbability' | 'fill'>,
  now: number,
): WantedObligation | null {
  if (probability < OPEN_PROBABILITY || !prepareCandidate(event, selfAddresses, now)) return null;
  const self = new Set(selfAddresses.map((address) => address.toLowerCase()));
  const organizer =
    personEmail(event.organizer) && !self.has(personEmail(event.organizer))
      ? event.organizer
      : otherPeople(event, selfAddresses)[0];
  const asker = clip(personName(organizer), 80);
  const title = clip(event.title || '(no title)', 120);
  const url = httpsUrl(event.htmlLink);
  const bar = settings.pushProbability ?? PUSH_PROBABILITY;
  return {
    kind: 'prepare',
    title: `Prepare for ${title}`,
    asker,
    ...(personEmail(organizer) ? { askerAddress: personEmail(organizer) } : {}),
    why: 'Something must be ready before this event starts.',
    ...(event.description ? { excerpt: clip(event.description, EXCERPT_CHARS) } : {}),
    due: 'today',
    dueAt: event.startAt,
    probability,
    pushLevel: !settings.fill && probability >= bar ? 'normal' : 'none',
    sourceAt: event.startAt,
    sourceLabel: title,
    ...(url ? { url } : {}),
    eventId: event.providerEventId,
    calendarId: event.providerCalendarId,
    eventStart: event.startAt,
  };
}

/** A stable revision of the parts of an event that the `prepare` question reads. */
export function prepareRevision(event: CalendarEventFacts): string {
  const source = JSON.stringify([
    event.title,
    event.description || '',
    event.location || '',
    event.startAt,
    (event.participants || []).map(personEmail).sort(),
  ]);
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++) hash = Math.imul(hash ^ source.charCodeAt(i), 16777619);
  return `prepare-1:${(hash >>> 0).toString(16)}:${source.length}`;
}

// ---------------------------------------------------------------------------
// The sweep (phase 1.1 and 4): times when a row changes by itself.
// ---------------------------------------------------------------------------

/** The fields of a row that the sweep reads. */
export interface SweepRow {
  kind: ObligationKind;
  state: string;
  pushLevel: PushLevel;
  sourceAt?: number;
  openedAt: number;
  eventStart?: number;
  snoozedUntil?: number;
}

/**
 * The next time the sweep must look at an open row, or undefined:
 * - a time-sensitive change leaves Now after CHANGE_NOW_WINDOW_MS;
 * - a change closes as `aged_out` after CHANGE_AUTO_CLOSE_MS;
 * - a calendar item closes as `event_passed` when its event starts.
 */
export function sweepAtFor(row: SweepRow): number | undefined {
  if (row.state !== 'open' && row.state !== 'snoozed') return undefined;
  if (row.kind === 'change') {
    const start = row.sourceAt ?? row.openedAt;
    return start + (row.pushLevel === 'time_sensitive' ? CHANGE_NOW_WINDOW_MS : CHANGE_AUTO_CLOSE_MS);
  }
  if ((row.kind === 'rsvp' || row.kind === 'prepare') && row.eventStart !== undefined) return row.eventStart;
  return undefined;
}

export type SweepStep =
  | { action: 'none' }
  | { action: 'defer'; sweepAt: number }
  | { action: 'demote'; sweepAt: number }
  | { action: 'close'; state: 'resolved' | 'expired'; closeReason: 'aged_out' | 'event_passed' };

/**
 * What the sweep does with one due row. A calendar item closes when its
 * event starts, also when it is snoozed. A change that the user put off to a
 * later time waits for that time.
 */
export function sweepStep(row: SweepRow, at: number): SweepStep {
  if (row.state !== 'open' && row.state !== 'snoozed') return { action: 'none' };
  if (row.kind === 'rsvp' || row.kind === 'prepare')
    return row.eventStart !== undefined && at >= row.eventStart
      ? { action: 'close', state: 'expired', closeReason: 'event_passed' }
      : row.eventStart !== undefined
        ? { action: 'defer', sweepAt: row.eventStart }
        : { action: 'none' };
  if (row.kind !== 'change') return { action: 'none' };
  if (row.state === 'snoozed' && (row.snoozedUntil ?? 0) > at)
    return { action: 'defer', sweepAt: row.snoozedUntil! };
  const start = row.sourceAt ?? row.openedAt;
  if (at >= start + CHANGE_AUTO_CLOSE_MS)
    return { action: 'close', state: 'resolved', closeReason: 'aged_out' };
  if (row.pushLevel === 'time_sensitive' && at >= start + CHANGE_NOW_WINDOW_MS)
    return { action: 'demote', sweepAt: start + CHANGE_AUTO_CLOSE_MS };
  return { action: 'defer', sweepAt: sweepAtFor(row)! };
}
