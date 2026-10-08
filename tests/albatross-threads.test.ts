import { describe, expect, test } from 'bun:test';
import type { RunActivity, ThreadStateView } from '../convex/albatrossThreads';
import {
  adjacentThread,
  buildThreadRows,
  filterThreadRows,
  nextNeedingYou,
  THREAD_STATUS_LABEL,
  type ThreadWorkInput,
  threadRow,
  threadStatus,
} from '../lib/albatross/threads';

// The thread list (docs/albatross-threads.md, T1–T3): one row per Albatross
// with a live status, one preview line, and an unread mark.

const NOW = 1_800_000_000_000;

function work(over: Partial<ThreadWorkInput> = {}): ThreadWorkInput {
  return {
    _id: 'w1',
    title: 'Renew the car registration',
    workState: 'active',
    status: 'ready',
    openQuestions: 0,
    nextStep: 'Renew online',
    areaName: 'Car',
    updatedAt: NOW - 60_000,
    lastUserTouchAt: NOW - 120_000,
    ...over,
  };
}

function run(over: Partial<RunActivity> = {}): RunActivity {
  return {
    runId: 'r1',
    state: 'running',
    outcome: null,
    stepTitle: 'Renew online',
    logLine: "Typed your saved Driver's license on dmv.ny.gov.",
    nextKind: null,
    nextLabel: null,
    nextDetail: null,
    allowAnswered: false,
    summary: null,
    error: null,
    stoppedBy: null,
    startedAt: NOW - 30_000,
    finishedAt: null,
    createdAt: NOW - 40_000,
    updatedAt: NOW - 5_000,
    ...over,
  };
}

function state(over: Partial<ThreadStateView> = {}): ThreadStateView {
  return {
    answering: false,
    answeringSince: null,
    replyAt: null,
    replyWaits: false,
    replyPreview: null,
    seenAt: NOW - 100_000,
    ...over,
  };
}

describe('threadStatus', () => {
  test('a working run wins, then a waiting run, then a running reply', () => {
    expect(threadStatus(work(), run(), state({ answering: true }))).toBe('in_progress');
    expect(threadStatus(work(), run({ state: 'queued' }), null)).toBe('starts_soon');
    expect(threadStatus(work(), null, state({ answering: true }))).toBe('answering');
  });

  test('handoffs map to what the user does next', () => {
    const handed = (outcome: RunActivity['outcome'], extra: Partial<RunActivity> = {}) =>
      threadStatus(work(), run({ state: 'handed_off', outcome, finishedAt: NOW - 1_000, ...extra }), null);
    expect(handed('needs_answer')).toBe('needs_answer');
    expect(handed('needs_answer', { allowAnswered: true })).toBe('idle');
    expect(handed('ready_for_you')).toBe('ready_for_you');
    expect(handed('your_turn')).toBe('your_turn');
    expect(handed('stopped')).toBe('did_not_finish');
  });

  test('a reply that waits, an open question, and the Work state', () => {
    expect(threadStatus(work(), null, state({ replyWaits: true }))).toBe('needs_answer');
    expect(threadStatus(work({ openQuestions: 2 }), null, null)).toBe('needs_answer');
    expect(threadStatus(work(), run({ state: 'failed' }), null)).toBe('did_not_finish');
    expect(threadStatus(work(), run({ state: 'cancelled' }), null)).toBe('stopped');
    expect(threadStatus(work({ workState: 'waiting' }), null, null)).toBe('waiting');
    expect(threadStatus(work({ workState: 'paused' }), null, null)).toBe('paused');
    expect(threadStatus(work({ workState: 'done' }), run({ state: 'done' }), null)).toBe('done');
    expect(threadStatus(work(), null, null)).toBe('idle');
  });
});

describe('threadRow', () => {
  test('a row in progress shows the newest log line and its run', () => {
    const row = threadRow(work(), run(), state());
    expect(row).toMatchObject({
      workId: 'w1',
      title: 'Renew the car registration',
      areaName: 'Car',
      status: 'in_progress',
      statusLabel: 'In progress',
      preview: "Typed your saved Driver's license on dmv.ny.gov.",
      working: true,
      needsYou: false,
      workingRunId: 'r1',
      unread: false,
      closed: false,
    });
    expect(threadRow(work(), run({ logLine: null }), null).preview).toBe('In progress: Renew online');
  });

  test('every status has a preview line', () => {
    const cases: Array<[ReturnType<typeof threadRow>['status'], string]> = [
      [
        threadRow(work(), run({ state: 'queued' }), null).status,
        threadRow(work(), run({ state: 'queued' }), null).preview,
      ],
      ['answering', threadRow(work(), null, state({ answering: true })).preview],
      [
        'needs_answer',
        threadRow(
          work(),
          run({
            state: 'handed_off',
            outcome: 'needs_answer',
            nextDetail: "Use your saved Driver's license on ny.gov?",
          }),
          null,
        ).preview,
      ],
      [
        'needs_answer',
        threadRow(work(), null, state({ replyWaits: true, replyPreview: 'Which class date?' })).preview,
      ],
      ['needs_answer', threadRow(work({ openQuestions: 2 }), null, null).preview],
      [
        'ready_for_you',
        threadRow(
          work(),
          run({ state: 'handed_off', outcome: 'ready_for_you', summary: 'I saved a draft.' }),
          null,
        ).preview,
      ],
      [
        'did_not_finish',
        threadRow(work(), run({ state: 'failed', error: 'The run failed. Try again.' }), null).preview,
      ],
      ['stopped', threadRow(work(), run({ state: 'cancelled' }), null).preview],
      ['done', threadRow(work({ workState: 'done' }), null, null).preview],
      ['idle', threadRow(work(), null, null).preview],
    ];
    expect(cases.map(([, line]) => line)).toEqual([
      'Renew online starts when a run ends.',
      'Albatross replies to your message.',
      "Use your saved Driver's license on ny.gov?",
      'Which class date?',
      '2 questions wait for you.',
      'I saved a draft.',
      'The run failed. Try again.',
      'Next: Renew online',
      'Done.',
      'Next: Renew online',
    ]);
    for (const label of Object.values(THREAD_STATUS_LABEL))
      expect(label).not.toMatch(/\bAI\b|assistant|agent/i);
  });

  test('unread: a run or a reply that ended after the user looked', () => {
    expect(
      threadRow(
        work(),
        run({ state: 'handed_off', outcome: 'ready_for_you', finishedAt: NOW - 1_000 }),
        state(),
      ).unread,
    ).toBe(true);
    expect(threadRow(work(), null, state({ replyAt: NOW - 1_000 })).unread).toBe(true);
    expect(threadRow(work(), null, state({ replyAt: NOW - 200_000 })).unread).toBe(false);
    // A log line alone is not news.
    expect(threadRow(work(), run({ updatedAt: NOW }), state()).unread).toBe(false);
    // Before the first visit, the user's own last touch counts as seen.
    expect(threadRow(work(), run({ state: 'done', finishedAt: NOW - 150_000 }), null).unread).toBe(false);
    expect(threadRow(work(), run({ state: 'done', finishedAt: NOW - 1_000 }), null).unread).toBe(true);
  });
});

describe('buildThreadRows and hopping', () => {
  const works = [
    work({ _id: 'idle', title: 'Plan the Lisbon trip', updatedAt: NOW - 10_000 }),
    work({ _id: 'busy', title: 'Renew the car registration', updatedAt: NOW - 500_000 }),
    work({ _id: 'asks', title: 'Pay the water bill', updatedAt: NOW - 900_000 }),
    work({ _id: 'done', title: 'File the tax return', workState: 'done', updatedAt: NOW }),
    work({ _id: 'gone', title: 'Old', workState: 'archived', updatedAt: NOW }),
  ];
  const activity = {
    now: NOW,
    runs: {
      busy: run({ runId: 'rb' }),
      asks: run({ runId: 'ra', state: 'handed_off', outcome: 'needs_answer', finishedAt: NOW - 800_000 }),
    },
    threads: { idle: state({ replyAt: NOW - 9_000 }) },
  };

  test('needs you first, then working, then the newest; closed last; archived out', () => {
    const rows = buildThreadRows(works, activity);
    expect(rows.map((row) => row.workId)).toEqual(['asks', 'busy', 'idle', 'done']);
    expect(buildThreadRows(works, null).map((row) => row.workId)).toEqual(['idle', 'busy', 'asks', 'done']);
  });

  test('filters, adjacent threads, and the next thread that needs you', () => {
    const rows = buildThreadRows(works, activity);
    expect(filterThreadRows(rows, 'needs_you').map((row) => row.workId)).toEqual(['asks']);
    expect(filterThreadRows(rows, 'working').map((row) => row.workId)).toEqual(['busy']);
    expect(filterThreadRows(rows, 'all')).toHaveLength(4);
    expect(adjacentThread(rows, 'busy', 1)).toBe('idle');
    expect(adjacentThread(rows, 'busy', -1)).toBe('asks');
    expect(adjacentThread(rows, 'asks', -1)).toBeNull();
    expect(adjacentThread(rows, null, 1)).toBe('asks');
    expect(adjacentThread(rows, null, -1)).toBe('done');
    expect(adjacentThread([], 'x', 1)).toBeNull();
    expect(nextNeedingYou(rows, 'busy')).toBe('asks');
    expect(nextNeedingYou(rows, 'asks')).toBeNull();
  });
});
