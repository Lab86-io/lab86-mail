// The thread list (docs/albatross-threads.md): one row per Albatross, with a
// live status, one preview line, and an unread mark. Web merges the Work list
// with albatrossThreads.activity live; native reads the merged rows from
// GET /api/albatross/threads. Both use this one function, so the rules agree.

import type { RunActivity, ThreadStateView } from '@/convex/albatrossThreads';
import { truncateText } from '../shared/text';
import { isClosed, type WorkStateInput, needsYou as workNeedsYou } from './work-state';

export type ThreadStatus =
  | 'in_progress'
  | 'starts_soon'
  | 'answering'
  | 'needs_answer'
  | 'your_turn'
  | 'ready_for_you'
  | 'did_not_finish'
  | 'stopped'
  | 'done'
  | 'waiting'
  | 'paused'
  | 'idle';

/** The status names every client shows (PR 1 state copy). */
export const THREAD_STATUS_LABEL: Record<ThreadStatus, string> = {
  in_progress: 'In progress',
  starts_soon: 'Starts soon',
  answering: 'Reply in progress',
  needs_answer: 'Needs your answer',
  your_turn: 'Your turn',
  ready_for_you: 'Ready for you',
  did_not_finish: 'Did not finish',
  stopped: 'Stopped by you',
  done: 'Done',
  waiting: 'Waiting',
  paused: 'Paused',
  idle: '',
};

/** Statuses that wait for the user. They sort first. A run that did not finish waits for a decision. */
export const NEEDS_YOU_STATUSES: readonly ThreadStatus[] = [
  'needs_answer',
  'your_turn',
  'ready_for_you',
  'did_not_finish',
];
/** Statuses where Albatross works now. They sort second. */
export const WORKING_STATUSES: readonly ThreadStatus[] = ['in_progress', 'starts_soon', 'answering'];

export interface ThreadWorkInput extends WorkStateInput {
  _id: string;
  title?: string | null;
  rawText?: string | null;
  areaName?: string | null;
  updatedAt: number;
  lastUserTouchAt?: number | null;
}

export interface ThreadActivity {
  runs: Record<string, RunActivity>;
  threads: Record<string, ThreadStateView>;
  now: number;
}

export interface ThreadRow {
  workId: string;
  title: string;
  areaName: string | null;
  status: ThreadStatus;
  statusLabel: string;
  /** One line under the title. Never more than 160 characters. */
  preview: string;
  stepTitle: string | null;
  needsYou: boolean;
  working: boolean;
  latestRunId: string | null;
  /** The run the row's Steer and Stop act on, when one works. */
  workingRunId: string | null;
  /** When the working run started, for the elapsed time on the row. */
  runStartedAt: number | null;
  lastActivityAt: number;
  seenAt: number | null;
  unread: boolean;
  closed: boolean;
}

function line(text: string | null | undefined) {
  const clean = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean ? truncateText(clean, 160) : '';
}

/** The status of one thread, from its newest run, its chat reply, and its Work. */
export function threadStatus(
  work: ThreadWorkInput,
  run: RunActivity | null,
  state: ThreadStateView | null,
): ThreadStatus {
  if (run?.state === 'running') return 'in_progress';
  if (run?.state === 'queued') return 'starts_soon';
  if (state?.answering) return 'answering';
  if (isClosed(work)) return 'done';
  if (run?.state === 'handed_off') {
    if (run.outcome === 'needs_answer' && !run.allowAnswered) return 'needs_answer';
    if (run.outcome === 'ready_for_you') return 'ready_for_you';
    if (run.outcome === 'your_turn') return 'your_turn';
    if (run.outcome === 'stopped') return 'did_not_finish';
  }
  if (state?.replyWaits) return 'needs_answer';
  if (workNeedsYou(work)) return 'needs_answer';
  if (run?.state === 'failed') return 'did_not_finish';
  if (run?.state === 'cancelled') return 'stopped';
  if (work.workState === 'waiting' || work.workState === 'blocked') return 'waiting';
  if (work.workState === 'paused') return 'paused';
  return 'idle';
}

function preview(
  status: ThreadStatus,
  work: ThreadWorkInput,
  run: RunActivity | null,
  state: ThreadStateView | null,
) {
  const step = run?.stepTitle ?? null;
  switch (status) {
    case 'in_progress':
      return line(run?.logLine) || line(step ? `In progress: ${step}` : '');
    case 'starts_soon':
      return line(step ? `${step} starts when a run ends.` : 'Starts when a run ends.');
    case 'answering':
      return 'Albatross replies to your message.';
    case 'needs_answer':
      if (run?.state === 'handed_off' && run.outcome === 'needs_answer')
        return line(run.nextDetail) || line(run.summary);
      if (state?.replyWaits) return line(state.replyPreview) || 'Albatross asks you a question.';
      return (work.openQuestions ?? 0) > 1
        ? `${work.openQuestions} questions wait for you.`
        : 'A question waits for you.';
    case 'your_turn':
    case 'ready_for_you':
      return line(run?.nextDetail) || line(run?.summary);
    case 'did_not_finish':
      return line(run?.error) || line(run?.summary) || line(step ? `Did not finish: ${step}` : '');
    case 'stopped':
      return line(work.nextStep ? `Next: ${work.nextStep}` : step ? `Stopped at: ${step}` : '');
    case 'done':
      return line(run?.summary) || 'Done.';
    default:
      return line(state?.replyPreview) || line(work.nextStep ? `Next: ${work.nextStep}` : '');
  }
}

/** The time of the newest activity that matters for unread: a run that ends, or a reply that ends. */
function meaningfulAt(run: RunActivity | null, state: ThreadStateView | null) {
  return Math.max(
    run && run.state !== 'running' && run.state !== 'queued' ? (run.finishedAt ?? 0) : 0,
    state?.replyAt ?? 0,
  );
}

export function threadRow(
  work: ThreadWorkInput,
  run: RunActivity | null,
  state: ThreadStateView | null,
): ThreadRow {
  const status = threadStatus(work, run, state);
  const seenAt = state?.seenAt ?? null;
  // Before the first visit after this change, the user's own last touch counts as seen.
  const seenBase = seenAt ?? work.lastUserTouchAt ?? 0;
  const lastActivityAt = Math.max(
    work.updatedAt,
    run?.updatedAt ?? 0,
    run?.finishedAt ?? 0,
    state?.replyAt ?? 0,
    state?.answeringSince ?? 0,
  );
  const meaningful = meaningfulAt(run, state);
  const working = WORKING_STATUSES.includes(status);
  return {
    workId: work._id,
    title: line(work.title || work.rawText) || 'Untitled Albatross',
    areaName: work.areaName ?? null,
    status,
    statusLabel: THREAD_STATUS_LABEL[status],
    preview: preview(status, work, run, state),
    stepTitle: run?.stepTitle ?? null,
    needsYou: NEEDS_YOU_STATUSES.includes(status),
    working,
    latestRunId: run?.runId ?? null,
    workingRunId: run && (run.state === 'running' || run.state === 'queued') ? run.runId : null,
    runStartedAt: run?.state === 'running' ? (run.startedAt ?? null) : null,
    lastActivityAt,
    seenAt,
    unread: meaningful > seenBase,
    closed: isClosed(work),
  };
}

function rank(row: ThreadRow) {
  if (row.needsYou) return 0;
  if (row.working) return 1;
  if (row.closed) return 3;
  return 2;
}

/** Every thread except archived ones: needs you, then working, then the newest; closed last. */
export function buildThreadRows(
  works: readonly ThreadWorkInput[],
  activity: ThreadActivity | null | undefined,
) {
  return works
    .filter((work) => work.workState !== 'archived' && work.status !== 'archived')
    .map((work) => threadRow(work, activity?.runs[work._id] ?? null, activity?.threads[work._id] ?? null))
    .sort((a, b) => rank(a) - rank(b) || b.lastActivityAt - a.lastActivityAt);
}

export type ThreadFilter = 'all' | 'needs_you' | 'working';

export function filterThreadRows(rows: readonly ThreadRow[], filter: ThreadFilter) {
  if (filter === 'needs_you') return rows.filter((row) => row.needsYou);
  if (filter === 'working') return rows.filter((row) => row.working);
  return [...rows];
}

/** The thread before or after the open one, for ⌘↑ / ⌘↓ (T3). Wraps at neither end. */
export function adjacentThread(rows: readonly ThreadRow[], workId: string | null, direction: 1 | -1) {
  if (!rows.length) return null;
  const index = workId ? rows.findIndex((row) => row.workId === workId) : -1;
  if (index < 0) return rows[direction === 1 ? 0 : rows.length - 1].workId;
  return rows[index + direction]?.workId ?? null;
}

/** The next thread that waits for the user, after the open one (T3). */
export function nextNeedingYou(rows: readonly ThreadRow[], workId: string | null) {
  const needing = rows.filter((row) => row.needsYou && row.workId !== workId);
  return needing[0]?.workId ?? null;
}
