import { describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { renderToStaticMarkup } from 'react-dom/server';
import { answerableQuestion, ThreadAnswerInPlace } from '../components/albatross/ThreadAnswerInPlace';
import { ThreadRail } from '../components/albatross/ThreadRail';
import { ThreadRow } from '../components/albatross/ThreadRow';
import {
  NoteReceiptLine,
  ReplyInProgressBubble,
  steerRunLabel,
  THREAD_ROUTE_COPY,
  ThreadRouteLine,
  threadComposerMode,
  threadComposerPlaceholder,
} from '../components/albatross/thread/ThreadSteering';
import { createThreadActions } from '../components/albatross/use-thread-actions';
import { classQuestionForm, threadRunFixtures } from '../lib/albatross/thread-fixtures';
import { THREAD_LIST_FIXTURE_IDS, threadListFixture } from '../lib/albatross/thread-list-fixtures';
import { NOTE_RECEIPT_COPY } from '../lib/albatross/thread-notes';
import type { ThreadRow as ThreadRowData } from '../lib/albatross/threads';

// The thread rail and its rows (docs/albatross-threads.md, T1–T3, T10, T12;
// lead decisions 1, 2, 7): every status renders with its word, the open row
// is marked, unread is weight, the hover actions are the right verbs, the
// in-place flows mount, and the steering pieces say the right things.

const NOW = Date.UTC(2026, 9, 8, 14, 46, 0);
const fixture = threadListFixture(NOW);
const ids = THREAD_LIST_FIXTURE_IDS;
const noop = () => undefined;
const yes = async () => true;

const byId = (workId: string) => {
  const row = fixture.rows.find((item) => item.workId === workId);
  if (!row) throw new Error(`no row ${workId}`);
  return row;
};

function dom(html: string) {
  return new JSDOM(html).window.document;
}

function rail(over: Partial<Parameters<typeof ThreadRail>[0]> = {}) {
  return renderToStaticMarkup(
    <ThreadRail
      rows={fixture.rows}
      laterCount={2}
      openWorkId={ids.car}
      filter="all"
      onFilterChange={noop}
      nowMs={NOW}
      timeZone="UTC"
      locale="en-US"
      onOpen={noop}
      onAction={noop}
      onSteer={yes}
      onMarkUnread={noop}
      {...over}
    />,
  );
}

function row(data: ThreadRowData, over: Partial<Parameters<typeof ThreadRow>[0]> = {}) {
  return renderToStaticMarkup(
    <ThreadRow
      row={data}
      variant="rail"
      nowMs={NOW}
      timeZone="UTC"
      locale="en-US"
      onOpen={noop}
      onAction={noop}
      onSteer={yes}
      onMarkUnread={noop}
      {...over}
    />,
  );
}

describe('the fixture rows', () => {
  test('come through buildThreadRows in the design order: needs you, in progress, then the newest', () => {
    expect(fixture.rows.map((item) => item.status)).toEqual([
      'needs_answer',
      'your_turn',
      'did_not_finish',
      'in_progress',
      'in_progress',
      'answering',
      'starts_soon',
      'idle',
      'stopped',
      'idle',
      'done',
    ]);
    expect(byId(ids.lisbon).unread).toBe(true);
    expect(byId(ids.library).unread).toBe(true);
    expect(byId(ids.car).unread).toBe(false);
  });
});

describe('the rail', () => {
  const doc = dom(rail());

  test('is a landmark with the filter words and live counts', () => {
    expect(doc.querySelector('nav[aria-label="Albatrosses"]')).not.toBeNull();
    const pills = [...doc.querySelectorAll('fieldset button')].map((node) => node.textContent?.trim());
    expect(pills).toEqual(['All10', 'Needs you3', 'In progress4']);
    expect(doc.querySelector('fieldset button[aria-pressed="true"]')?.textContent).toContain('All');
  });

  test('groups Needs you, In progress, and Open, and keeps the finished count at the foot', () => {
    const groups = [...doc.querySelectorAll('section[aria-label]')].map((node) =>
      node.getAttribute('aria-label'),
    );
    expect(groups).toEqual(['Needs you', 'In progress', 'Open']);
    expect(doc.body.textContent).toContain('Finished · 1');
    expect(doc.body.textContent).toContain('Later · 2');
  });

  test('marks the open thread, and gives the list one tab stop', () => {
    const open = doc.querySelector('[data-thread-row-main][aria-current="page"]');
    expect(open?.closest('[data-thread-row]')?.getAttribute('data-thread-row')).toBe(ids.car);
    const stops = [...doc.querySelectorAll('[data-thread-row-main]')].filter(
      (node) => node.getAttribute('tabindex') === '0',
    );
    expect(stops).toHaveLength(1);
    expect(stops[0].getAttribute('aria-current')).toBe('page');
  });

  test('every row names its status word and preview for a reader', () => {
    const names = [...doc.querySelectorAll('[data-thread-row-main]')].map((node) =>
      node.getAttribute('aria-label'),
    );
    expect(names[0]).toBe('Plan the Lisbon trip, Needs your answer, Which dates work?, 3m, unread');
    // The server's own preview for a reply in progress (lib/albatross/threads.ts).
    expect(
      names.some((name) => name?.includes('Reply in progress, Albatross replies to your message.')),
    ).toBe(true);
    expect(names.some((name) => name?.includes('Starts soon, Cancel online starts when a run ends.'))).toBe(
      true,
    );
    expect(names.some((name) => name?.includes('Stopped by you, Next: Call the county line, 555-0144'))).toBe(
      true,
    );
  });

  test('the live region exists and starts empty', () => {
    const live = doc.querySelector('[aria-live="polite"]');
    expect(live).not.toBeNull();
    expect(live?.textContent).toBe('');
  });

  test('filters narrow the groups; an empty filter shows its own words', () => {
    const needs = dom(rail({ filter: 'needs_you' }));
    expect(
      [...needs.querySelectorAll('section[aria-label]')].map((node) => node.getAttribute('aria-label')),
    ).toEqual(['Needs you']);
    const empty = dom(rail({ filter: 'working', rows: fixture.rows.filter((item) => !item.working) }));
    expect(empty.querySelector('[data-thread-rail-empty="working"]')?.textContent).toContain(
      'No run is in progress.',
    );
    const loading = dom(rail({ rows: undefined }));
    expect(loading.body.textContent).toContain('Loading');
  });

  test('a thread in an Area names the Area in its header', () => {
    expect(dom(rail({ areaName: 'Travel' })).querySelector('h2')?.textContent).toBe('Albatrosses · Travel');
  });
});

describe('a row', () => {
  test('an unread row is semibold with the accent time; a read working row recedes', () => {
    const unread = dom(row(byId(ids.lisbon)));
    expect(unread.querySelector('[data-thread-row]')?.getAttribute('data-thread-unread')).toBe('true');
    expect(unread.querySelector('[data-thread-row-main] .font-semibold')).not.toBeNull();
    expect(unread.querySelector('[data-thread-time]')?.className).toContain('var(--color-accent)');
    const working = dom(row(byId(ids.water)));
    expect(working.querySelector('[data-thread-row]')?.className).toContain('opacity-[0.72]');
    const open = dom(row(byId(ids.water), { open: true }));
    expect(open.querySelector('[data-thread-row]')?.className).not.toContain('opacity-[0.72]');
  });

  test('the dot speaks in the status voice: accent for needs you, accent-2 with a halo for work, hollow for starts soon', () => {
    const dot = (data: ThreadRowData) =>
      dom(row(data)).querySelector('[data-thread-row-main] > span')?.className ?? '';
    expect(dot(byId(ids.lisbon))).toContain('bg-[var(--color-accent)]');
    expect(dot(byId(ids.car))).toContain('thread-dot-halo');
    expect(dot(byId(ids.car))).toContain('var(--color-accent-2)');
    expect(dot(byId(ids.gym))).toContain('border-[var(--color-accent-2)]');
    expect(dot(byId(ids.recycling))).toContain('border-[var(--color-border-strong)]');
    expect(dom(row(byId(ids.passport))).body.textContent).toContain('Did not finish');
  });

  test('the time: elapsed while a run works, since activity otherwise, "Draft" when a draft waits', () => {
    expect(dom(row(byId(ids.car))).querySelector('[data-thread-time]')?.textContent).toBe('1m');
    expect(dom(row(byId(ids.water))).querySelector('[data-thread-time]')?.textContent).toBe('14m');
    expect(dom(row(byId(ids.passport))).querySelector('[data-thread-time]')?.textContent).toBe('Yesterday');
    expect(
      dom(row(byId(ids.passport), { hasDraft: true })).querySelector('[data-thread-time]')?.textContent,
    ).toBe('Draft');
    expect(
      dom(row(byId(ids.passport), { hasDraft: true, open: true })).querySelector('[data-thread-time]')
        ?.textContent,
    ).toBe('Yesterday');
  });

  test('the hover actions are the right verbs, text only, outside the main button', () => {
    const actions = (data: ThreadRowData) =>
      [...dom(row(data)).querySelectorAll('[data-thread-row-action]')].map((node) => node.textContent);
    expect(actions(byId(ids.lisbon))).toEqual(['Answer']);
    expect(actions(byId(ids.dentist))).toEqual(['Open']);
    expect(actions(byId(ids.car))).toEqual(['Steer', 'Stop']);
    expect(actions(byId(ids.lease))).toEqual(['Stop']);
    expect(actions(byId(ids.gym))).toEqual(['Stop']);
    expect(actions(byId(ids.passport))).toEqual(['Try again']);
    expect(actions(byId(ids.recycling))).toEqual(['Handle it']);
    expect(actions(byId(ids.insurance))).toEqual([]);
    const doc = dom(row(byId(ids.car)));
    expect(doc.querySelector('[data-thread-row-main] button')).toBeNull();
    for (const node of doc.querySelectorAll('[data-thread-row-action]')) {
      expect(node.firstElementChild).toBeNull();
    }
  });

  test('the list variant shows the area and the serif title for a prominent row', () => {
    const doc = dom(row(byId(ids.lisbon), { variant: 'list', prominent: true }));
    expect(doc.body.textContent).toContain('Travel');
    expect(doc.querySelector('[data-thread-row-main] .font-serif')).not.toBeNull();
  });

  test('an in-place panel renders inside the row', () => {
    const doc = dom(row(byId(ids.lisbon), { inPlace: <p>Which dates work?</p> }));
    expect(doc.querySelector('[data-thread-row-in-place]')?.textContent).toBe('Which dates work?');
  });
});

describe('answer in place', () => {
  const runs = threadRunFixtures(NOW);
  const lisbon = byId(ids.lisbon);
  // One choice field: small enough for a row. The full class form carries an address, which opens the thread.
  const smallForm = { ...classQuestionForm, fields: classQuestionForm.fields.slice(0, 1) };
  const withQuestion = [
    { ...runs.needsAnswer, id: 'run_lisbon', question: { ...runs.needsAnswer.question!, form: smallForm } },
  ];

  test('a small pending form opens in place; a long form or an allow opens the thread', () => {
    expect(answerableQuestion(lisbon, withQuestion).inPlace).toBe(true);
    const long = [{ ...withQuestion[0], question: { ...withQuestion[0].question, form: classQuestionForm } }];
    expect(answerableQuestion(lisbon, long).inPlace).toBe(false);
    const allow = [{ ...withQuestion[0], next: { ...withQuestion[0].next!, kind: 'allow_secure' as const } }];
    expect(answerableQuestion(lisbon, allow).inPlace).toBe(false);
    expect(answerableQuestion(lisbon, [runs.done]).question).toBeNull();
  });

  test('renders the form card with "Open the thread" and Cancel; a gone question says so', () => {
    const doc = dom(
      renderToStaticMarkup(
        <ThreadAnswerInPlace
          row={lisbon}
          runs={withQuestion}
          submit={async () => undefined}
          onDone={noop}
          onCancel={noop}
          onOpenThread={noop}
        />,
      ),
    );
    expect(doc.querySelector('[data-thread-answer-in-place]')).not.toBeNull();
    expect(doc.body.textContent).toContain('Which class?');
    expect(doc.body.textContent).toContain('Open the thread');
    expect(doc.body.textContent).toContain('Cancel');
    const gone = dom(
      renderToStaticMarkup(
        <ThreadAnswerInPlace
          row={lisbon}
          runs={[runs.done]}
          onDone={noop}
          onCancel={noop}
          onOpenThread={noop}
        />,
      ),
    );
    expect(gone.body.textContent).toContain('This question is no longer open.');
  });
});

describe('steering pieces', () => {
  const run = { id: 'run_car', stepTitle: 'Renew online', stepNumber: 2 };

  test('the mode and the placeholder follow the run, Ask instead, and an armed redirect', () => {
    expect(threadComposerMode({ run, askInstead: false, redirectRunId: null })).toBe('run');
    expect(threadComposerMode({ run, askInstead: true, redirectRunId: null })).toBe('ask');
    expect(threadComposerMode({ run: null, askInstead: false, redirectRunId: null })).toBe('ask');
    expect(threadComposerMode({ run: null, askInstead: false, redirectRunId: 'run_car' })).toBe('redirect');
    expect(threadComposerPlaceholder('run')).toBe('Tell the run what to change');
    expect(threadComposerPlaceholder('redirect')).toBe('What should Albatross do instead?');
    expect(threadComposerPlaceholder('ask')).toBeNull();
    expect(steerRunLabel(run)).toBe('Step 2, Renew online');
    expect(steerRunLabel({ stepTitle: 'Renew online', stepNumber: null })).toBe('Renew online');
  });

  test('the route line in its three modes', () => {
    const line = (mode: 'run' | 'ask' | 'redirect', target: typeof run | null = run) =>
      dom(
        renderToStaticMarkup(
          <ThreadRouteLine mode={mode} run={target} onStopAndRedirect={noop} onCancelRedirect={noop} />,
        ),
      );
    const runLine = line('run');
    expect(runLine.querySelector('[data-thread-route="run"]')?.textContent).toContain(
      'To the run·Step 2, Renew online',
    );
    expect([...runLine.querySelectorAll('button')].map((node) => node.textContent)).toEqual([
      'Stop and redirect',
    ]);
    const askLine = line('ask');
    expect(askLine.querySelector('[data-thread-route="ask"]')?.textContent).toContain(
      'To Albatross·The run keeps going',
    );
    expect(askLine.querySelector('button')).toBeNull();
    const redirectLine = line('redirect', null);
    expect(redirectLine.querySelector('[data-thread-route="redirect"]')?.textContent).toContain(
      THREAD_ROUTE_COPY.redirectArmed,
    );
    expect(line('run', null).body.textContent).toBe('');
  });

  test('the receipt line and the reply placeholder', () => {
    const read = dom(
      renderToStaticMarkup(
        <NoteReceiptLine
          receipt={{ kind: 'read', line: 'Read by Albatross · 2:40 PM', sendAgain: false, readAt: NOW }}
        />,
      ),
    );
    expect(read.querySelector('[data-note-receipt="read"]')?.textContent).toBe('Read by Albatross · 2:40 PM');
    const notRead = dom(
      renderToStaticMarkup(
        <NoteReceiptLine
          receipt={{ kind: 'not_read', line: NOTE_RECEIPT_COPY.notRead, sendAgain: true, readAt: null }}
          onSendAgain={noop}
        />,
      ),
    );
    expect(notRead.querySelector('button')?.textContent).toBe('Send again');
    const reply = dom(renderToStaticMarkup(<ReplyInProgressBubble onStop={noop} />));
    expect(reply.querySelector('[data-reply-in-progress]')?.textContent).toContain('Reply in progress');
    expect(reply.querySelector('button')?.textContent).toBe('Stop');
  });
});

describe('the row actions', () => {
  function harness() {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const notices: Array<{ message: string; action?: string }> = [];
    const errors: string[] = [];
    const seen: Array<[string, boolean | undefined]> = [];
    const opened: string[] = [];
    let fail = false;
    const actions = createThreadActions({
      post: async (url, body) => {
        calls.push({ url, body });
        if (fail) throw new Error('No.');
        return { ok: true, runId: 'run_new' };
      },
      notice: (message, options) => notices.push({ message, action: options?.action?.label }),
      error: (message) => errors.push(message),
      markSeen: async (workId, unread) => {
        seen.push([workId, unread]);
      },
      openThread: (workId) => opened.push(workId),
    });
    return {
      actions,
      calls,
      notices,
      errors,
      seen,
      opened,
      setFail: (value: boolean) => (fail = value),
    };
  }

  test('Stop cancels the run without a dialog and offers Continue', async () => {
    const h = harness();
    await h.actions.stop(byId(ids.car));
    expect(h.calls[0]).toEqual({
      url: `/api/albatross/work/${ids.car}/run`,
      body: { action: 'cancel', runId: 'run_car' },
    });
    expect(h.notices).toEqual([{ message: 'Stopped. The run can continue from here.', action: 'Continue' }]);
    h.setFail(true);
    await h.actions.stop(byId(ids.water));
    expect(h.errors).toEqual(['No.']);
  });

  test('Try again and Handle it start the step; Open and Answer open the thread', () => {
    const h = harness();
    h.actions.act('try_again', byId(ids.passport));
    h.actions.act('handle', byId(ids.recycling));
    h.actions.act('open', byId(ids.dentist));
    h.actions.act('answer', byId(ids.lisbon));
    expect(h.calls.map((call) => call.body.action)).toEqual(['start', 'start']);
    expect(h.opened).toEqual([ids.dentist, ids.lisbon]);
  });

  test('Steer sends one note with a note id (the server keeps it in the thread); a failed send returns false', async () => {
    const h = harness();
    expect(await h.actions.steer(byId(ids.car), '  Pay once, no autopay ')).toBe(true);
    expect(h.calls[0].body).toMatchObject({
      action: 'steer',
      runId: 'run_car',
      note: 'Pay once, no autopay',
    });
    expect(String(h.calls[0].body.noteId).startsWith('note_')).toBe(true);
    expect(h.calls).toHaveLength(1);
    expect(await h.actions.steer(byId(ids.insurance), 'x')).toBe(false);
    h.setFail(true);
    expect(await h.actions.steer(byId(ids.car), 'x')).toBe(false);
  });

  test('Stop on a reply in progress stops the reply on the server, with no Continue', async () => {
    const h = harness();
    await h.actions.stop(byId(ids.lease));
    expect(h.calls).toEqual([{ url: '/api/agent/stop', body: { sessionId: `work-${ids.lease}` } }]);
    expect(h.notices).toEqual([]);
  });

  test('Mark as unread asks the server for it', async () => {
    const h = harness();
    await h.actions.markUnread(byId(ids.car));
    expect(h.seen).toEqual([[ids.car, true]]);
  });
});
