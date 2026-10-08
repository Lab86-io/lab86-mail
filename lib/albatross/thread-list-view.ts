// The thread list as the web client shows it (docs/albatross-threads.md,
// docs/research/albatross-threads-web-design-2026-10-08.md, and the lead's
// cross-platform decisions): the groups, the status voice of a row, the time
// label, the hover actions, the order hold while the pointer is in the rail,
// the screen-reader announcements, and the hop keys. Pure: no React here.
// Status itself comes from the server (`buildThreadRows`); nothing here
// re-derives it.

import type { ThreadFilter, ThreadRow, ThreadStatus } from './threads';

// ---------------------------------------------------------------------------
// Filters and groups.
// ---------------------------------------------------------------------------

export const THREAD_FILTERS: readonly ThreadFilter[] = ['all', 'needs_you', 'working'];

export const THREAD_FILTER_LABEL: Record<ThreadFilter, string> = {
  all: 'All',
  needs_you: 'Needs you',
  working: 'In progress',
};

export type ThreadGroupKey = 'needs_you' | 'working' | 'open' | 'waiting' | 'paused' | 'finished';

export const THREAD_GROUP_LABEL: Record<ThreadGroupKey, string> = {
  needs_you: 'Needs you',
  working: 'In progress',
  open: 'Open',
  waiting: 'Waiting',
  paused: 'Paused',
  finished: 'Finished',
};

export const THREAD_GROUP_HINT: Record<ThreadGroupKey, string> = {
  needs_you: 'Albatross cannot move these without you.',
  working: 'Albatross works on these now.',
  open: 'Nothing is in motion. Albatross has the next step.',
  waiting: 'These depend on somebody or something else.',
  paused: 'You stopped these on purpose.',
  finished: 'These reached the outcome you wanted.',
};

/** The list's group of a row. The rail folds waiting and paused into "Open". */
export function threadGroupKey(row: ThreadRow): ThreadGroupKey {
  if (row.needsYou) return 'needs_you';
  if (row.working) return 'working';
  if (row.closed) return 'finished';
  if (row.status === 'waiting') return 'waiting';
  if (row.status === 'paused') return 'paused';
  return 'open';
}

export interface ThreadGroup {
  key: ThreadGroupKey;
  rows: ThreadRow[];
}

const LIST_GROUP_ORDER: readonly ThreadGroupKey[] = [
  'needs_you',
  'working',
  'open',
  'waiting',
  'paused',
  'finished',
];

/** The full list: six groups in this order; empty groups are left out. */
export function listThreadGroups(rows: readonly ThreadRow[]): ThreadGroup[] {
  const byKey = new Map<ThreadGroupKey, ThreadRow[]>();
  for (const row of rows) {
    const key = threadGroupKey(row);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(row);
    else byKey.set(key, [row]);
  }
  return LIST_GROUP_ORDER.map((key) => ({ key, rows: byKey.get(key) ?? [] })).filter((group) =>
    Boolean(group.rows.length),
  );
}

/** The rail: Needs you, In progress, Open. Finished rows are a count at the foot, not a group. */
export function railThreadGroups(rows: readonly ThreadRow[]): ThreadGroup[] {
  const groups = listThreadGroups(rows.filter((row) => !row.closed));
  const open = groups.filter(
    (group) => group.key === 'open' || group.key === 'waiting' || group.key === 'paused',
  );
  const rest = groups.filter((group) => group.key === 'needs_you' || group.key === 'working');
  const folded = open.flatMap((group) => group.rows);
  return folded.length ? [...rest, { key: 'open', rows: folded }] : rest;
}

export function countThreads(rows: readonly ThreadRow[]) {
  return {
    all: rows.filter((row) => !row.closed).length,
    needsYou: rows.filter((row) => row.needsYou).length,
    working: rows.filter((row) => row.working).length,
    finished: rows.filter((row) => row.closed).length,
  };
}

// ---------------------------------------------------------------------------
// The voice of a row.
// ---------------------------------------------------------------------------

/**
 * The dot (lead decision 2): needs you is the accent, steady; a run or a reply
 * in progress is accent-2 with one slow halo; starts soon is hollow; done is
 * the success voice; the rest are quiet.
 */
export type ThreadTone = 'needs_you' | 'working' | 'starts_soon' | 'done' | 'quiet';

export function threadTone(status: ThreadStatus): ThreadTone {
  switch (status) {
    case 'needs_answer':
    case 'your_turn':
    case 'ready_for_you':
    case 'did_not_finish':
      return 'needs_you';
    case 'in_progress':
    case 'answering':
      return 'working';
    case 'starts_soon':
      return 'starts_soon';
    case 'done':
      return 'done';
    default:
      return 'quiet';
  }
}

/** The status word keeps the dot's voice, except "Did not finish", which speaks in the danger voice. */
export type StatusWordTone = ThreadTone | 'failed';

export function statusWordTone(status: ThreadStatus): StatusWordTone {
  return status === 'did_not_finish' ? 'failed' : threadTone(status);
}

/**
 * Rows that work, and read rows that do not need the user, recede (T3 Code's
 * rule). The open thread and every "needs you" row keep full strength, and an
 * unread row never recedes.
 */
export function threadRowRecedes(row: Pick<ThreadRow, 'needsYou' | 'working' | 'unread'>, open: boolean) {
  if (open || row.needsYou) return false;
  if (row.working) return true;
  return !row.unread;
}

// ---------------------------------------------------------------------------
// The time label.
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "now", "12m", "1h 4m": how long a run has worked. */
export function elapsedLabel(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function dayKey(at: number, timeZone: string | undefined) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(at));
}

/** "now", "3m", "5h", "Yesterday", "Mon", "Oct 3", "Oct 3, 2025": time since the newest activity. */
export function sinceLabel(at: number, nowMs: number, locale?: string, timeZone?: string): string {
  const delta = Math.max(0, nowMs - at);
  if (delta < MINUTE) return 'now';
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m`;
  if (delta < DAY && dayKey(at, timeZone) === dayKey(nowMs, timeZone)) return `${Math.floor(delta / HOUR)}h`;
  if (dayKey(at, timeZone) === dayKey(nowMs - DAY, timeZone)) return 'Yesterday';
  if (delta < 7 * DAY)
    return new Intl.DateTimeFormat(locale, { timeZone, weekday: 'short' }).format(new Date(at));
  const sameYear =
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric' }).format(new Date(at)) ===
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric' }).format(new Date(nowMs));
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(new Date(at));
}

/** Elapsed time while a run works (lead decision 2); time since activity otherwise. */
export function threadTimeLabel(
  row: Pick<ThreadRow, 'working' | 'runStartedAt' | 'lastActivityAt'>,
  nowMs: number,
  locale?: string,
  timeZone?: string,
): string {
  if (row.working && row.runStartedAt) return elapsedLabel(nowMs - row.runStartedAt);
  return sinceLabel(row.lastActivityAt, nowMs, locale, timeZone);
}

// ---------------------------------------------------------------------------
// Hover actions (T10).
// ---------------------------------------------------------------------------

export type ThreadRowActionKind = 'answer' | 'open' | 'steer' | 'stop' | 'try_again' | 'handle';

export interface ThreadRowAction {
  kind: ThreadRowActionKind;
  label: string;
  /** The one action that carries the accent. */
  primary: boolean;
}

export const THREAD_ROW_ACTION_LABEL: Record<ThreadRowActionKind, string> = {
  answer: 'Answer',
  open: 'Open',
  steer: 'Steer',
  stop: 'Stop',
  try_again: 'Try again',
  handle: 'Handle it',
};

export function threadRowActions(row: Pick<ThreadRow, 'status' | 'workingRunId'>): ThreadRowAction[] {
  const action = (kind: ThreadRowActionKind, primary = false) => ({
    kind,
    label: THREAD_ROW_ACTION_LABEL[kind],
    primary,
  });
  switch (row.status) {
    case 'needs_answer':
      return [action('answer', true)];
    case 'your_turn':
    case 'ready_for_you':
      return [action('open', true)];
    case 'in_progress':
      return row.workingRunId ? [action('steer', true), action('stop')] : [];
    case 'starts_soon':
      return row.workingRunId ? [action('stop')] : [];
    case 'answering':
      return [action('stop')];
    case 'did_not_finish':
      return [action('try_again', true)];
    case 'stopped':
      return [action('handle', true)];
    default:
      return [];
  }
}

export const THREAD_ROW_COPY = {
  steerPlaceholder: 'Tell the run what to change',
  steerSend: 'Send',
  steerHint: 'Albatross reads this at its next step.',
  steerSent: 'Sent to the run',
  answerOpenThread: 'Open the thread',
  answerCancel: 'Cancel',
  markUnread: 'Mark as unread',
  openThread: 'Open',
  draft: 'Draft',
  stoppedNotice: 'Stopped. The run can continue from here.',
  continueAction: 'Continue',
  stopFailed: 'The run did not stop.',
  steerFailed: 'The note did not reach the run.',
  finishedFoot: 'Finished',
  laterFoot: 'Later',
  hopHint: '⌘↑ ⌘↓',
} as const;

/** The maximum length of a note sent from a row (the server's own cap). */
export const STEER_NOTE_MAX = 2_000;

/** A form opens in place only when it is small; a long form, or a form with a structured field, opens the thread. */
export function formOpensInPlace(
  form: { fields: ReadonlyArray<{ kind: string }> } | null | undefined,
): boolean {
  if (!form) return false;
  if (form.fields.length > 4) return false;
  return !form.fields.some((field) => field.kind === 'address' || field.kind === 'contact');
}

// ---------------------------------------------------------------------------
// The order hold.
// ---------------------------------------------------------------------------

/**
 * While the pointer is in the rail, or a row has focus, the order of the rows
 * holds: a row that is already shown keeps its place, and a new row takes the
 * place the fresh order gives it. Groups still change at once, because the
 * group comes from the row's own status.
 */
export function holdThreadOrder(
  previous: readonly ThreadRow[],
  next: readonly ThreadRow[],
  hold: boolean,
): ThreadRow[] {
  if (!hold || !previous.length) return [...next];
  const fresh = new Map(next.map((row) => [row.workId, row]));
  const kept = previous.flatMap((row) => {
    const current = fresh.get(row.workId);
    return current ? [current] : [];
  });
  const keptIds = new Set(kept.map((row) => row.workId));
  const out = [...kept];
  next.forEach((row, index) => {
    if (keptIds.has(row.workId)) return;
    out.splice(Math.min(index, out.length), 0, row);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Announcements (one polite live region, three event kinds).
// ---------------------------------------------------------------------------

export type ThreadEventKind = 'needs_you' | 'finished' | 'did_not_finish';

export interface ThreadEvent {
  kind: ThreadEventKind;
  title: string;
}

/** What changed between two snapshots. The open thread announces through its own run block. */
export function threadEvents(
  previous: readonly ThreadRow[],
  next: readonly ThreadRow[],
  skipWorkId: string | null = null,
): ThreadEvent[] {
  const before = new Map(previous.map((row) => [row.workId, row]));
  const events: ThreadEvent[] = [];
  for (const row of next) {
    if (row.workId === skipWorkId) continue;
    const old = before.get(row.workId);
    if (!old) continue;
    if (row.status === 'did_not_finish' && old.status !== 'did_not_finish') {
      events.push({ kind: 'did_not_finish', title: row.title });
      continue;
    }
    if (row.needsYou && !old.needsYou) {
      events.push({ kind: 'needs_you', title: row.title });
      continue;
    }
    if (old.working && !row.working && !row.needsYou) events.push({ kind: 'finished', title: row.title });
  }
  return events;
}

const COUNT_WORDS = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];

function countWord(count: number) {
  return COUNT_WORDS[count] ?? String(count);
}

/** One merged sentence per event kind, so a busy rail does not flood a screen reader. */
export function announcementText(events: readonly ThreadEvent[]): string | null {
  const titles = (kind: ThreadEventKind) =>
    events.filter((event) => event.kind === kind).map((event) => event.title);
  const parts: string[] = [];
  const needs = titles('needs_you');
  if (needs.length)
    parts.push(
      `${countWord(needs.length)} ${needs.length === 1 ? 'Albatross needs' : 'Albatrosses need'} you: ${needs.join(', ')}.`,
    );
  const finished = titles('finished');
  if (finished.length) parts.push(`Finished: ${finished.join(', ')}.`);
  const failed = titles('did_not_finish');
  if (failed.length) parts.push(`Did not finish: ${failed.join(', ')}.`);
  return parts.length ? parts.join(' ') : null;
}

/** The least time between two announcements. */
export const ANNOUNCE_EVERY_MS = 5_000;

// ---------------------------------------------------------------------------
// Hop keys (T3, lead decision 4).
// ---------------------------------------------------------------------------

export type HopDirection = 'previous' | 'next' | 'needs_you';

export interface HopKeyInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * ⌘↑ / ⌘↓ outside a text field, ⌥⌘↑ / ⌥⌘↓ everywhere (in a text field ⌘↑ moves
 * the caret), ⌥⌘↩ for the next thread that needs you. Ctrl stands in for ⌘
 * where there is no ⌘.
 */
export function hopDirection(event: HopKeyInput, inTextField: boolean): HopDirection | null {
  const mod = event.metaKey || event.ctrlKey;
  if (!mod || event.shiftKey) return null;
  if (event.key === 'Enter') return event.altKey ? 'needs_you' : null;
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return null;
  if (inTextField && !event.altKey) return null;
  return event.key === 'ArrowUp' ? 'previous' : 'next';
}

/** True for an input, a textarea, or an editable element: the keys that move the caret stay theirs. */
export function isTextFieldTarget(target: unknown): boolean {
  const element = target as {
    tagName?: string;
    isContentEditable?: boolean;
    closest?: (s: string) => unknown;
  } | null;
  if (!element || typeof element.tagName !== 'string') return false;
  const tag = element.tagName.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (element.isContentEditable) return true;
  return Boolean(element.closest?.('[contenteditable="true"]'));
}

// ---------------------------------------------------------------------------
// Accessibility.
// ---------------------------------------------------------------------------

/** The name of a row for a screen reader: title, status, preview, time, and unread. */
export function threadRowAccessibleName(
  row: Pick<ThreadRow, 'title' | 'statusLabel' | 'preview' | 'unread'>,
  timeLabel: string,
): string {
  const parts = [row.title, row.statusLabel, row.preview, timeLabel].filter(Boolean);
  if (row.unread) parts.push('unread');
  return parts.join(', ');
}

// ---------------------------------------------------------------------------
// Empty states.
// ---------------------------------------------------------------------------

export const RAIL_EMPTY_COPY: Record<ThreadFilter, { title: string; detail: string }> = {
  all: { title: 'Nothing on your shoulders yet.', detail: 'Tell Albatross what you keep meaning to handle.' },
  needs_you: { title: 'Nothing needs you.', detail: 'Albatross asks here when it cannot go further.' },
  working: { title: 'No run is in progress.', detail: 'Press Handle it in a thread to start one.' },
};
