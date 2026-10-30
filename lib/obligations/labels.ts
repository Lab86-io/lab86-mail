// Needs you: the words on a row and in the detail. Pure, so the page, the
// preview, and the tests print the same words for the same item.

import { horizonClock } from '@/lib/albatross/horizon';
import {
  OBLIGATION_SOURCE_LABELS,
  type ObligationAction,
  type ObligationCloseReason,
  type ObligationSource,
  type ObligationView,
} from './contract';
import { isClosedObligation } from './groups';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const LOCALE = 'en-US';

/** A zone that Intl accepts, or undefined for the device zone. */
export function safeTimeZone(timezone: string | undefined): string | undefined {
  if (!timezone) return undefined;
  try {
    new Intl.DateTimeFormat(LOCALE, { timeZone: timezone });
    return timezone;
  } catch {
    return undefined;
  }
}

function format(ms: number, timezone: string | undefined, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(LOCALE, { ...options, timeZone: safeTimeZone(timezone) }).format(ms);
}

/** The reason word of a closed row. */
export function closeReasonLabel(reason: ObligationCloseReason | undefined): string {
  switch (reason) {
    case 'sent_reply':
      return 'Replied';
    case 'user_done':
      return 'Done';
    case 'user_done_no_reply':
      return 'Done, no reply sent';
    case 'evidence':
      return 'Closed by itself';
    case 'not_mine':
      return 'Not mine';
    case 'code_used':
      return 'Code used';
    case 'expired':
      return 'Expired';
    case 'event_passed':
      return 'Event started';
    case 'aged_out':
      return 'Closed by itself';
    default:
      return 'Closed';
  }
}

/** The kind word of the row meta and the detail source line. */
export function kindLabel(obligation: Pick<ObligationView, 'kind' | 'pushLevel'>): string {
  switch (obligation.kind) {
    case 'reply':
      return 'Reply';
    case 'action':
      return 'Action';
    case 'waiting':
      return 'Waiting';
    case 'change':
      return obligation.pushLevel === 'time_sensitive' ? 'Time-sensitive change' : 'Change';
    case 'code':
      return 'Code';
    case 'rsvp':
      return 'Invitation';
    case 'prepare':
      return 'Prepare';
  }
}

function startOfDay(ms: number, timezone: string | undefined): number {
  const clock = horizonClock(safeTimeZone(timezone));
  const day = clock.today(ms);
  return clock.midnight(day.year, day.month, day.day);
}

function dayDistance(ms: number, now: number, timezone: string | undefined): number {
  return Math.round((startOfDay(ms, timezone) - startOfDay(now, timezone)) / DAY_MS);
}

function timeOfDay(ms: number, timezone: string | undefined): string {
  return format(ms, timezone, { hour: 'numeric', minute: '2-digit' });
}

/**
 * When something happened: "9:12 AM" today, "Yesterday 4:48 PM", a weekday
 * with the time inside the week, else "Oct 24".
 */
export function whenLabel(ms: number, now: number, timezone: string | undefined): string {
  const distance = dayDistance(ms, now, timezone);
  if (distance === 0) return timeOfDay(ms, timezone);
  if (distance === -1) return `Yesterday ${timeOfDay(ms, timezone)}`;
  if (distance > -7 && distance < 7) {
    return `${format(ms, timezone, { weekday: 'short' })} ${timeOfDay(ms, timezone)}`;
  }
  return format(ms, timezone, { month: 'short', day: 'numeric' });
}

/** "just now", "2 min ago", "3 hr ago", "2 days ago". */
export function agoLabel(ms: number, now: number): string {
  const delta = Math.max(0, now - ms);
  if (delta < MINUTE_MS) return 'just now';
  if (delta < HOUR_MS) return `${Math.floor(delta / MINUTE_MS)} min ago`;
  if (delta < DAY_MS) return `${Math.floor(delta / HOUR_MS)} hr ago`;
  const days = Math.floor(delta / DAY_MS);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

/** "8 min", "1 hr 5 min", or "Expired". */
export function expiryLabel(expiresAt: number, now: number): string {
  const left = expiresAt - now;
  if (left <= 0) return 'Expired';
  const minutes = Math.ceil(left / MINUTE_MS);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

/** The share of the code's life that is left, 0 to 1, for the expiry ring. */
export function expiryFraction(obligation: Pick<ObligationView, 'createdAt' | 'code'>, now: number): number {
  const expiresAt = obligation.code?.expiresAt;
  if (!expiresAt || expiresAt <= obligation.createdAt) return 0;
  const fraction = (expiresAt - now) / (expiresAt - obligation.createdAt);
  return Math.min(1, Math.max(0, fraction));
}

/**
 * The due day as a word: "Today", "Today 6:40 PM", "Tomorrow", "Fri", "Nov 16".
 * A day in the past reads "Yesterday" or its date, never "Today".
 */
export function dueDayLabel(dueAt: number, now: number, timezone: string | undefined): string {
  const distance = dayDistance(dueAt, now, timezone);
  const clockTime = dueAt - startOfDay(dueAt, timezone);
  // A due day from the evidence ends at 23:59:59.999. That is the day, not a stated time.
  const endOfDay = startOfDay(dueAt + 1, timezone) === dueAt + 1;
  const withTime = (word: string) =>
    clockTime && !endOfDay ? `${word} ${timeOfDay(dueAt, timezone)}` : word;
  if (distance === -1) return withTime('Yesterday');
  if (distance < -1) return format(dueAt, timezone, { month: 'short', day: 'numeric' });
  if (distance === 0) return withTime('Today');
  if (distance === 1) return withTime('Tomorrow');
  if (distance < 7) return format(dueAt, timezone, { weekday: 'short' });
  return format(dueAt, timezone, { month: 'short', day: 'numeric' });
}

export type DueTone = 'plain' | 'today' | 'hot' | 'done';

export interface DueLabel {
  /** The word in the due column. Empty when the row has nothing to say. */
  text: string;
  /** A second, smaller word under the first: "expires", "waiting". */
  sub?: string;
  tone: DueTone;
}

/** The due column of one row. */
export function dueLabel(obligation: ObligationView, now: number, timezone: string | undefined): DueLabel {
  if (isClosedObligation(obligation)) return { text: closeReasonLabel(obligation.closeReason), tone: 'done' };
  if (obligation.kind === 'code') {
    const expiresAt = obligation.code?.expiresAt;
    if (!expiresAt) return { text: '', tone: 'plain' };
    const text = expiryLabel(expiresAt, now);
    return text === 'Expired' ? { text, tone: 'plain' } : { text, sub: 'expires', tone: 'hot' };
  }
  if (obligation.kind === 'waiting') {
    const days = Math.floor((now - obligation.createdAt) / DAY_MS);
    return {
      text: days < 1 ? 'Today' : days === 1 ? '1 day' : `${days} days`,
      sub: 'waiting',
      tone: 'plain',
    };
  }
  const hot = obligation.pushLevel === 'time_sensitive';
  if (obligation.dueAt !== undefined) {
    const text = dueDayLabel(obligation.dueAt, now, timezone);
    return { text, tone: hot ? 'hot' : text.startsWith('Today') ? 'today' : 'plain' };
  }
  if (obligation.due === 'today') return { text: 'Today', tone: hot ? 'hot' : 'today' };
  if (obligation.due === 'soon') return { text: 'Soon', tone: hot ? 'hot' : 'plain' };
  if (obligation.due === 'later') return { text: 'Later', tone: 'plain' };
  return { text: '', tone: hot ? 'hot' : 'plain' };
}

/** "Due Friday", for the detail source line. Empty without a due day. */
export function dueSentence(obligation: ObligationView, now: number, timezone: string | undefined): string {
  if (isClosedObligation(obligation) || obligation.kind === 'code' || obligation.kind === 'waiting')
    return '';
  if (obligation.dueAt !== undefined) {
    const distance = dayDistance(obligation.dueAt, now, timezone);
    if (distance > 1 && distance < 7) return `Due ${format(obligation.dueAt, timezone, { weekday: 'long' })}`;
    const label = dueDayLabel(obligation.dueAt, now, timezone);
    return `Due ${/^(Today|Tomorrow)/.test(label) ? label[0].toLowerCase() + label.slice(1) : label}`;
  }
  if (obligation.due === 'today') return 'Due today';
  if (obligation.due === 'soon') return 'Due soon';
  if (obligation.due === 'later') return 'Due later';
  return '';
}

/** The sentence at the top of the detail. */
export function obligationSentence(
  obligation: Pick<ObligationView, 'kind' | 'asker' | 'title' | 'code'>,
): string {
  if (obligation.kind === 'code')
    return `Verification code from ${obligation.code?.issuer || obligation.asker}.`;
  return obligation.title;
}

/** Groups of three digits read easier: "482913" shows as "482 913". */
export function spacedCode(value: string): string {
  const compact = value.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(compact) && !/^\d{8}$/.test(compact)) return value;
  const size = compact.length === 8 ? 4 : 3;
  return compact.match(new RegExp(`.{1,${size}}`, 'g'))?.join(' ') ?? value;
}

// ---- Sources (phase 2) -------------------------------------------------------

/** "Mail", "Slack", "Jira", "GitHub": the source word of a row and a detail. */
export function sourceWord(obligation: Pick<ObligationView, 'source'>): string {
  return OBLIGATION_SOURCE_LABELS[obligation.source] ?? OBLIGATION_SOURCE_LABELS.mail;
}

/** "Slack · #release": the source word, then where in the source when the item names it. */
export function sourceWords(obligation: Pick<ObligationView, 'source' | 'sourceLabel'>): string {
  const label = obligation.sourceLabel?.trim();
  return label ? `${sourceWord(obligation)} · ${label}` : sourceWord(obligation);
}

/** "Open in Slack": the quiet link that opens the item in its own app. */
export function openInLabel(obligation: Pick<ObligationView, 'source'>): string {
  return `Open in ${sourceWord(obligation)}`;
}

/** The item's link in its own app. Only an https link opens from the app; anything else reads as none. */
export function safeSourceUrl(obligation: Pick<ObligationView, 'url'>): string | null {
  const raw = obligation.url?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

export type RowLeadKind = 'code' | 'glyph' | 'person';

const GLYPH_SOURCES: readonly ObligationSource[] = ['granola', 'atlassian', 'bitbucket'];

/**
 * The round lead of a row: initials for a person, a monochrome source glyph
 * for a meeting, an issue, a pipeline, or an event to prepare for, a key for a code.
 */
export function rowLeadKind(obligation: Pick<ObligationView, 'kind' | 'source'>): RowLeadKind {
  if (obligation.kind === 'code') return 'code';
  if (obligation.kind === 'prepare' || GLYPH_SOURCES.includes(obligation.source)) return 'glyph';
  return 'person';
}

/** "Tomorrow 3:00 PM": when the event of an rsvp or prepare item starts. Empty without one. */
export function eventStartLabel(
  obligation: Pick<ObligationView, 'eventStart'>,
  now: number,
  timezone: string | undefined,
): string {
  if (obligation.eventStart === undefined) return '';
  return dueDayLabel(obligation.eventStart, now, timezone);
}

// ---- Actions ------------------------------------------------------------------

/** The first action of an item: the one Cmd+Enter runs and the row pill shows. */
export type PrimaryAction = 'copy' | 'send_reply' | 'rsvp' | 'start_albatross' | 'done';

/** A reply with a prepared draft is a mail reply. A Drive or Slack reply opens in its app. */
export function canSendReply(obligation: Pick<ObligationView, 'kind' | 'source'>): boolean {
  return obligation.kind === 'reply' && obligation.source === 'mail';
}

/** True when "Start in Albatross" applies: every kind but a code. */
export function canStartAlbatross(obligation: Pick<ObligationView, 'kind'>): boolean {
  return obligation.kind !== 'code';
}

export function primaryAction(obligation: Pick<ObligationView, 'kind' | 'source' | 'workId'>): PrimaryAction {
  if (obligation.kind === 'code') return 'copy';
  if (canSendReply(obligation)) return 'send_reply';
  if (obligation.kind === 'rsvp') return 'rsvp';
  if (obligation.workId) return 'start_albatross';
  return 'done';
}

/** The pill a row shows on hover beside Done, or null when Done is the only one. */
export function primaryPillLabel(
  obligation: Pick<ObligationView, 'kind' | 'source' | 'workId'>,
): string | null {
  switch (primaryAction(obligation)) {
    case 'copy':
      return 'Copy';
    case 'send_reply':
      return 'Reply';
    case 'rsvp':
      return 'Yes';
    case 'start_albatross':
      return 'Start in Albatross';
    default:
      return null;
  }
}

/** The title of the toast after an action: the same word as the button. */
export function actionToastTitle(action: ObligationAction): string {
  switch (action.action) {
    case 'done':
      return 'Done';
    case 'later':
      return 'Later';
    case 'not_mine':
      return 'Not mine';
    case 'rsvp':
      return `Answered ${action.response}`;
    default:
      return 'Undone';
  }
}

/** The item as the input of a run: a person's message, or the thing itself. */
function albatrossInput(obligation: Pick<ObligationView, 'source' | 'asker'>): string {
  switch (obligation.source) {
    case 'calendar':
      return 'this event';
    case 'granola':
      return 'this meeting';
    case 'atlassian':
      return 'this issue';
    case 'bitbucket':
      return 'this item';
    default:
      return `${obligation.asker}’s message`;
  }
}

/** What "Start in Albatross" does for this item. */
export function albatrossNote(
  obligation: Pick<ObligationView, 'source' | 'workId' | 'workTitle' | 'asker'>,
): string {
  const input = `${albatrossInput(obligation)} as its input`;
  if (!obligation.workId) return `Starts a new Albatross with ${input}.`;
  return `Starts a run in ${obligation.workTitle?.trim() || 'the Albatross'} with ${input}.`;
}

/** The quiet line under the action buttons. */
export function actionNote(
  obligation: Pick<ObligationView, 'kind' | 'source' | 'workId' | 'workTitle' | 'asker'>,
): string {
  switch (obligation.kind) {
    case 'reply':
      return canSendReply(obligation)
        ? 'Send reply answers in the thread. Done closes this without a reply. Undo for 10 seconds.'
        : `Reply in ${sourceWord(obligation)}. Done closes this. Undo for 10 seconds.`;
    case 'code':
      return 'This closes itself when you use the code or when it expires.';
    case 'waiting':
      return 'This closes itself when the reply arrives. Done closes it now. Undo for 10 seconds.';
    case 'rsvp':
      // The answer goes to the calendar at once: an RSVP has no undo window.
      return 'Yes, No, and Maybe answer the invitation in your calendar. An answer has no Undo.';
    case 'prepare':
      return 'Done closes this. It closes itself when the event starts. Undo for 10 seconds.';
    default:
      return obligation.workId
        ? `${albatrossNote(obligation)} Done closes this. Undo for 10 seconds.`
        : 'Done closes this. Undo for 10 seconds.';
  }
}
