// Needs you: the words on a row and in the detail. Pure, so the page, the
// preview, and the tests print the same words for the same item.

import { horizonClock } from '@/lib/albatross/horizon';
import type { ObligationCloseReason, ObligationView } from './contract';
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

/** The quiet line under the action buttons. */
export function actionNote(obligation: Pick<ObligationView, 'kind'>): string {
  switch (obligation.kind) {
    case 'reply':
      return 'Send reply answers in the thread. Done closes this without a reply. Undo for 10 seconds.';
    case 'code':
      return 'This closes itself when you use the code or when it expires.';
    case 'waiting':
      return 'This closes itself when the reply arrives. Done closes it now. Undo for 10 seconds.';
    default:
      return 'Done closes this. Undo for 10 seconds.';
  }
}
