// Needs you (docs/needs-you.md): the shared contract between the server
// (Jev rules, the obligations table, push delivery), the web page, and the
// native apps. Phase 1 covers mail and one-time codes. Phase 2 adds the
// connected sources, phase 3 the Albatross threads and the brief, phase 4 the
// calendar, and phase 5 the native apps (docs/needs-you-phases-2-5.md).

/** What the user owes, or waits for. */
export type ObligationKind = 'reply' | 'action' | 'waiting' | 'change' | 'code' | 'rsvp' | 'prepare';

export type ObligationState = 'open' | 'snoozed' | 'done' | 'resolved' | 'dismissed' | 'expired';

/** Where the item came from. Phase 1: mail. Phase 2: the connected sources. Phase 4: calendar. */
export type ObligationSource =
  | 'mail'
  | 'slack'
  | 'atlassian'
  | 'granola'
  | 'drive'
  | 'github'
  | 'bitbucket'
  | 'calendar';

export const OBLIGATION_SOURCES = [
  'mail',
  'slack',
  'atlassian',
  'granola',
  'drive',
  'github',
  'bitbucket',
  'calendar',
] as const;

/** The source name the page shows next to the asker. */
export const OBLIGATION_SOURCE_LABELS: Record<ObligationSource, string> = {
  mail: 'Mail',
  slack: 'Slack',
  atlassian: 'Jira',
  granola: 'Granola',
  drive: 'Drive',
  github: 'GitHub',
  bitbucket: 'Bitbucket',
  calendar: 'Calendar',
};

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
  | 'expired'
  /** A calendar item after its event started, or an RSVP after the user answered. */
  | 'event_passed'
  /** A change with nothing to do, closed by itself after CHANGE_AUTO_CLOSE_MS. */
  | 'aged_out';

export const OBLIGATION_KINDS = ['reply', 'action', 'waiting', 'change', 'code', 'rsvp', 'prepare'] as const;
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
  'event_passed',
  'aged_out',
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
  /**
   * Stable key of the source item: `mail:<accountId>:<threadId>`, the content
   * item key for a connected source, or `calendar:<accountId>:<eventId>`.
   */
  sourceKey: string;
  /** Where in the source: "#release", "LAB-212", "northwind/web #482", the meeting title. */
  sourceLabel?: string;
  /** An https link that opens the item in its own app (Slack, Jira, GitHub, ...). */
  url?: string;
  accountId?: string;
  threadId?: string;
  /** The evidence message: the reply goes to it, and the deep link opens it. */
  messageId?: string;
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
  /** The title of the Albatross that `workId` names, for the row and the detail. */
  workTitle?: string;
  /** Calendar items: the event and its start time. */
  eventId?: string;
  eventStart?: number;
  pushLevel: PushLevel;
  probability: number;
  /** Set only for `code`. The value is shown in the app and copied by the user. */
  code?: { value: string; issuer?: string; expiresAt?: number };
  snoozedUntil?: number;
  /** True when POST /api/obligations/[id]/draft has a prepared reply for the current source message. */
  draftReady?: boolean;
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
  | { action: 'undo' }
  /** Calendar `rsvp` items only. Closes the item as `event_passed` after the answer is sent. */
  | { action: 'rsvp'; response: 'yes' | 'no' | 'maybe' };

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

/**
 * `POST /api/obligations/[id]/albatross` ("Start in Albatross"). With a
 * `workId`, the item goes into that Albatross's thread as its input and a run
 * starts. Without one, a new Albatross starts from the item.
 */
export interface ObligationAlbatrossResponse {
  workId: string;
  /** True when a new Albatross was made. */
  created: boolean;
  obligation: ObligationView;
  /**
   * Set when the item reached a run of that Albatross: a run that works now
   * got it as a note, or a new run started with it. A new Albatross makes its
   * plan first and has no run yet.
   */
  runId?: string;
}

/** One closed item for "Closed by itself since the last letter". */
export interface ObligationClosedNote {
  id: string;
  title: string;
  asker: string;
  source: ObligationSource;
  closeReason: ObligationCloseReason;
  closedAt: number;
}

/**
 * The Daily Brief region `needs-you` (phase 3). It takes the place of the
 * `answer` lane. The edition stores this shape; web, iOS, and macOS render it.
 */
export interface BriefNeedsYouRegion {
  id: 'needs-you';
  /** Open items now, the Now group count, and the items due today. */
  open: number;
  now: number;
  dueToday: number;
  /** The Now items, then the items due today: at most BRIEF_NEEDS_YOU_LIMIT. Codes never. */
  items: ObligationView[];
  /** Items that closed since the previous edition without a user action. At most 5. */
  closedSince: ObligationClosedNote[];
  /**
   * The time of the previous edition, when there was one. The closed line
   * says "since yesterday’s letter" or "since the last letter" from it, the
   * same in the composed letter and in each live refresh.
   */
  previousGeneratedAt?: number;
}

export const BRIEF_NEEDS_YOU_LIMIT = 6;

/** A change goes into Now only while it is this new (phase 1.1). Older, it goes to Today. */
export const CHANGE_NOW_WINDOW_MS = 48 * 60 * 60 * 1000;

/** A change with nothing to do closes by itself after this long, as `aged_out`. */
export const CHANGE_AUTO_CLOSE_MS = 3 * 24 * 60 * 60 * 1000;

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
