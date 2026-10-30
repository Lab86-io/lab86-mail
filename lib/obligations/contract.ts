// Needs you (docs/needs-you.md): the shared contract between the server
// (Jev rules, the obligations table, push delivery) and the web page. Phase 1
// covers mail obligations, one-time codes, and the Albatross items that the
// Notifications page already shows.

/** What the user owes, or waits for. */
export type ObligationKind = 'reply' | 'action' | 'waiting' | 'change' | 'code';

export type ObligationState = 'open' | 'snoozed' | 'done' | 'resolved' | 'dismissed' | 'expired';

/** Phase 1 sources. Slack, Atlassian, Granola, Drive, GitHub, Bitbucket, and calendar come in phase 2 and 4. */
export type ObligationSource = 'mail';

/** Jev's answer to the `due` question: when the owner must act, by the evidence. */
export type ObligationDue = 'today' | 'soon' | 'later' | 'none';

export type PushLevel = 'none' | 'normal' | 'time_sensitive';

/** Why an obligation closed. The closed row shows it. */
export type ObligationCloseReason =
  | 'sent_reply'
  | 'user_done'
  | 'user_done_no_reply'
  | 'evidence'
  | 'not_mine'
  | 'code_used'
  | 'expired';

export const OBLIGATION_KINDS = ['reply', 'action', 'waiting', 'change', 'code'] as const;
export const OBLIGATION_STATES = ['open', 'snoozed', 'done', 'resolved', 'dismissed', 'expired'] as const;
export const OBLIGATION_DUES = ['today', 'soon', 'later', 'none'] as const;
export const PUSH_LEVELS = ['none', 'normal', 'time_sensitive'] as const;
export const OBLIGATION_CLOSE_REASONS = [
  'sent_reply',
  'user_done',
  'user_done_no_reply',
  'evidence',
  'not_mine',
  'code_used',
  'expired',
] as const;

/** States that count as closed. */
export const CLOSED_STATES: readonly ObligationState[] = ['done', 'resolved', 'dismissed', 'expired'];

/**
 * The page groups, in display order. Items with a due date always come before
 * items without one (decision 7).
 */
export type NeedsYouGroupId =
  | 'now'
  | 'today'
  | 'this_week'
  | 'after_this_week'
  | 'no_date'
  | 'waiting'
  | 'closed_today';

export const NEEDS_YOU_GROUP_ORDER: readonly NeedsYouGroupId[] = [
  'now',
  'today',
  'this_week',
  'after_this_week',
  'no_date',
  'waiting',
  'closed_today',
];

export const NEEDS_YOU_GROUP_LABELS: Record<NeedsYouGroupId, string> = {
  now: 'Now',
  today: 'Today',
  this_week: 'This week',
  after_this_week: 'After this week',
  no_date: 'No due date',
  waiting: 'Waiting on others',
  closed_today: 'Closed today',
};

/** One open, snoozed, or recently closed obligation, as the page reads it. */
export interface ObligationView {
  id: string;
  kind: ObligationKind;
  state: ObligationState;
  source: ObligationSource;
  /** Stable key of the source item: `mail:<accountId>:<threadId>`. */
  sourceKey: string;
  accountId?: string;
  threadId?: string;
  /** One line about what the user owes, from the evidence. */
  title: string;
  /** The person or service that asked. */
  asker: string;
  askerAddress?: string;
  /** "Why this needs you": the evidence text, one or two sentences. */
  why?: string;
  /** A short excerpt of the source message. */
  excerpt?: string;
  due: ObligationDue;
  /** A concrete due time when the evidence names one (for example "by Friday"). */
  dueAt?: number;
  workId?: string;
  pushLevel: PushLevel;
  probability: number;
  /** Set only for `code`. The value is shown in the app and copied by the user. */
  code?: { value: string; issuer?: string; expiresAt?: number };
  snoozedUntil?: number;
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
  closeReason?: ObligationCloseReason;
}

/** The user's actions on one obligation. `undo` reverses the last close inside UNDO_WINDOW_MS. */
export type ObligationAction =
  | { action: 'done' }
  | { action: 'later'; until: number }
  | { action: 'not_mine' }
  | { action: 'undo' };

/** `api.obligations.needsYou` (Convex query, signed-in user). */
export interface NeedsYouSnapshot {
  /** False when the user is not in LAB86_NEEDS_YOU. The page then shows the old Notifications view. */
  enabled: boolean;
  /** The user's IANA time zone, for "today" and "this week". */
  timezone: string;
  /** Open and snoozed obligations, and the obligations closed since the start of the user's day. */
  items: ObligationView[];
}

/** `POST /api/obligations/[id]` with an ObligationAction body. */
export interface ObligationActionResponse {
  obligation: ObligationView;
  /** Set when the action can be undone: the end of the Undo window. */
  undoUntil?: number;
}

/** `POST /api/obligations/[id]/draft`: a prepared reply for a mail `reply` obligation. */
export interface ObligationDraftResponse {
  draft: { to: string[]; cc: string[]; subject: string; body: string };
}

/** `POST /api/obligations/[id]/reply` with `{ body }`: sends the reply in the thread and closes the obligation as `sent_reply`. */
export interface ObligationReplyResponse {
  obligation: ObligationView;
  undoUntil?: number;
}

/** Done, Later, and Not mine show Undo for this long (decision 8). */
export const UNDO_WINDOW_MS = 10_000;

/** At most this many pushes in one hour, codes not included. More become one summary push. */
export const PUSH_HOURLY_LIMIT = 4;

/** An obligation needs at least this probability to push. Below it, it is in-app only. Tune with scripts/eval-jev-mail.ts. */
export const PUSH_PROBABILITY = 0.85;

/** A closed obligation stays in "Closed today" until the end of the user's day. */
export const CLOSED_TODAY = 'closed_today' as const;

/**
 * `LAB86_NEEDS_YOU`: "all", or a comma list of user ids. Off when empty. A
 * user in the flag gets obligation pushes and the Needs you page, and no
 * per-mail pushes. Everyone else keeps the old behavior.
 */
export function needsYouFlagFor(userId: string, raw = process.env.LAB86_NEEDS_YOU): boolean {
  const value = String(raw || '').trim();
  if (!value || !userId) return false;
  if (value.toLowerCase() === 'all') return true;
  return value
    .split(',')
    .map((entry) => entry.trim())
    .includes(userId);
}

/** The source key of one mail thread. */
export function mailSourceKey(accountId: string, threadId: string): string {
  return `mail:${accountId}:${threadId}`;
}
