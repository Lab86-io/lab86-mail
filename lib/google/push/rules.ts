// Direct Google push: the timing and health rules that the app and the Convex
// crons share (docs/google-direct-transport.md, "Push"). This file has no
// imports, so the Convex bundle can use it too.
//
// A row of `googlePushChannels` is one Gmail watch (one row for each
// mailbox), one Calendar channel (one for each calendar), or one Drive
// channel (one for each Drive connection). A row is `pending` while the watch
// call runs, `active` after Google accepted it, and `failed` after Google
// refused it. `requestedAt` is the time before the last watch call.
// `lastMessageAt` is the time of the last message from Google.

export type GooglePushKind = 'gmail' | 'calendar' | 'drive';
export type GooglePushStatus = 'pending' | 'active' | 'failed';

export interface GooglePushTiming {
  status: GooglePushStatus;
  requestedAt: number;
  expiration?: number;
  renewedAt?: number;
  lastMessageAt?: number;
  retryAfter?: number;
  unsupported?: boolean;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Gmail asks for a watch call once a day. A watch ends after 7 days. */
export const GMAIL_WATCH_RENEW_AFTER_MS = 20 * HOUR_MS;
/** The life that a new channel asks for. Drive gives at most one week to a changes channel. */
export const PUSH_CHANNEL_TTL_MS = 7 * DAY_MS;
/** A watch or a channel that ends within this time gets a replacement. */
export const PUSH_RENEW_BEFORE_MS = 2 * DAY_MS;
/** A watch or a channel must have at least this much time left to count as live. */
export const PUSH_EXPIRY_MARGIN_MS = 10 * MINUTE_MS;
/** A registration that stays `pending` for this long has stopped. A new one starts. */
export const PUSH_PENDING_TIMEOUT_MS = 10 * MINUTE_MS;
/** The wait after Google refused a watch call. */
export const PUSH_RETRY_AFTER_FAILURE_MS = 6 * HOUR_MS;
/** The wait after Google said that it cannot watch a calendar (for example a holiday calendar). */
export const PUSH_RETRY_AFTER_UNSUPPORTED_MS = 7 * DAY_MS;
/**
 * A Gmail watch with no push for this long is not healthy. Each daily renewal
 * makes Gmail send one push, so a working path never stays quiet this long.
 */
export const GMAIL_PUSH_SILENCE_MS = 26 * HOUR_MS;
/** The interval of the Gmail History cron (convex/crons.ts). */
export const GMAIL_HISTORY_TICK_MS = 2 * MINUTE_MS;
/** The fallback History poll of a mailbox with healthy push. */
export const GMAIL_PUSH_FALLBACK_POLL_MS = 15 * MINUTE_MS;
/** The fallback calendar poll of an account with healthy push. The daily full pass stays. */
export const CALENDAR_PUSH_FALLBACK_POLL_MS = HOUR_MS;
/** Convex writes a new message time at most this often, except for the first message after a watch call. */
export const PUSH_MESSAGE_WRITE_INTERVAL_MS = 5 * MINUTE_MS;

/** The row is active, and it has more than the margin left. */
export function pushRowLive(row: GooglePushTiming, now: number): boolean {
  return (
    row.status === 'active' &&
    typeof row.expiration === 'number' &&
    row.expiration - PUSH_EXPIRY_MARGIN_MS > now
  );
}

/**
 * Google sent a message after the last watch call. A Gmail watch call sends
 * one push at once, and a new Calendar or Drive channel sends a `sync`
 * message, so this proves that the delivery path works.
 */
export function pushRowVerified(row: GooglePushTiming): boolean {
  return typeof row.lastMessageAt === 'number' && row.lastMessageAt >= row.requestedAt;
}

/** The mailbox gets its changes by push: a live, verified watch with a recent push. */
export function gmailPushHealthy(row: GooglePushTiming | null | undefined, now: number): boolean {
  if (!row || !pushRowLive(row, now) || !pushRowVerified(row)) return false;
  return now - (row.lastMessageAt as number) < GMAIL_PUSH_SILENCE_MS;
}

/** The Gmail watch needs a watch call now. */
export function gmailWatchDue(row: GooglePushTiming | null | undefined, now: number): boolean {
  if (!row) return true;
  if (row.status === 'failed') return (row.retryAfter ?? 0) <= now;
  if (row.status === 'pending') return now - row.requestedAt >= PUSH_PENDING_TIMEOUT_MS;
  if ((row.expiration ?? 0) - PUSH_RENEW_BEFORE_MS <= now) return true;
  return now - (row.renewedAt ?? row.requestedAt) >= GMAIL_WATCH_RENEW_AFTER_MS;
}

/** The newest channel of a calendar or a Drive connection needs a replacement now. */
export function channelRenewDue(row: GooglePushTiming | null | undefined, now: number): boolean {
  if (!row) return true;
  if (row.status === 'failed') return (row.retryAfter ?? 0) <= now;
  if (row.status === 'pending') return now - row.requestedAt >= PUSH_PENDING_TIMEOUT_MS;
  return (row.expiration ?? 0) - PUSH_RENEW_BEFORE_MS <= now;
}

/**
 * A calendar account gets its changes by push when each of its calendars has
 * a live, verified channel. A calendar that Google cannot watch does not
 * count against the account. An account with no calendars is not healthy.
 */
export function calendarAccountPushHealthy(
  calendarIds: readonly string[],
  rows: ReadonlyArray<GooglePushTiming & { calendarId?: string }>,
  now: number,
): boolean {
  if (!calendarIds.length) return false;
  return calendarIds.every((calendarId) =>
    rows.some(
      (row) =>
        row.calendarId === calendarId &&
        (row.unsupported === true || (pushRowLive(row, now) && pushRowVerified(row))),
    ),
  );
}

/** The message time must go to Convex: the first message after a watch call, or the stored time is old. */
export function pushMessageWriteDue(row: GooglePushTiming, now: number): boolean {
  if (!pushRowVerified(row)) return true;
  return now - (row.lastMessageAt as number) >= PUSH_MESSAGE_WRITE_INTERVAL_MS;
}

/** A stable offset in [0, spanMs) for one key (FNV-1a), so the work of many keys spreads out. */
export function pushSpreadOffsetMs(key: string, spanMs: number): number {
  if (spanMs <= 0) return 0;
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
  return (hash >>> 0) % Math.floor(spanMs);
}

/**
 * The History cron reads this mailbox on this tick. A mailbox without healthy
 * push is read on each tick (every 2 minutes). A mailbox with healthy push is
 * read once in each fallback period: on the tick that falls in the first tick
 * interval of its own shifted period.
 */
export function gmailPollDue({
  now,
  key,
  healthy,
  periodMs = GMAIL_PUSH_FALLBACK_POLL_MS,
  tickMs = GMAIL_HISTORY_TICK_MS,
}: {
  now: number;
  key: string;
  healthy: boolean;
  periodMs?: number;
  tickMs?: number;
}): boolean {
  if (!healthy || periodMs <= tickMs) return true;
  const phase = (now + pushSpreadOffsetMs(`gmail-poll:${key}`, periodMs)) % periodMs;
  return phase < tickMs;
}

/**
 * The page token in a stored Drive content cursor (lib/content/cloud-sync.ts),
 * or undefined. The cursor can wrap the token in `next` (a page with files
 * still to read) or in `resume` (a reconcile pass).
 */
export function drivePageToken(cursor: unknown): string | undefined {
  const root = cursor as Record<string, any> | null | undefined;
  for (const candidate of [root, root?.next, root?.resume, root?.resume?.next]) {
    const token = candidate?.token;
    if (
      (candidate?.phase === 'changes' || candidate?.phase === 'backfill') &&
      typeof token === 'string' &&
      token
    ) {
      return token;
    }
  }
  return undefined;
}
