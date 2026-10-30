// Needs you, part 2 (docs/needs-you.md, "Part 2: rules decide the message").
// Jev gives the probabilities; these rules turn one assessment into the
// obligations of one thread. Pure: Convex (convex/obligations.ts) and the
// tests run the same code. Jev writes no text, so every line here comes from
// the source: the subject, the evidence message, and fixed copy.

import { addDays } from 'date-fns';
import { assessmentDue, type JevAssessment } from '../jev/contract';
import { isVipSender } from '../notifications/mail-push';
import { emailFromHeader } from '../shared/format';
import { parseIsoInTimezone } from '../shared/timezones';
import { type ObligationDue, type ObligationKind, PUSH_PROBABILITY, type PushLevel } from './contract';

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
  /** The evidence message: the reply anchor and the deep link. */
  messageId: string;
  workId?: string;
}

const TITLE_CHARS = 160;
const EXCERPT_CHARS = 400;
const SOON_MS = 3 * 86_400_000;

/** Subject kinds whose change pushes at the time-sensitive level. */
const TIME_SENSITIVE_CHANGES = new Set(['finance', 'booking', 'account']);

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
    };
  };
  for (const obligation of assessment.obligations) {
    const item = build(obligation.kind, obligation.evidence, obligation.probability);
    if (obligation.kind !== 'waiting' && person && obligation.probability >= bar) {
      const dueSoon =
        due === 'today' || due === 'soon' || (item.dueAt !== undefined && item.dueAt <= now + SOON_MS);
      const vip = isVipSender(item.askerAddress, settings.vipSenders);
      if (dueSoon || vip || workRecent) item.pushLevel = 'normal';
    }
    wanted.push(item);
  }
  if (assessment.meaningfulChange && assessment.changeEvidence) {
    const probability = assessment.probabilities.change ?? 1;
    const item = build('change', assessment.changeEvidence, probability);
    if (TIME_SENSITIVE_CHANGES.has(assessment.subjectKind) && probability >= bar)
      item.pushLevel = 'time_sensitive';
    wanted.push(item);
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
