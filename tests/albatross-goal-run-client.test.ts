import { describe, expect, test } from 'bun:test';
import { documentHandoffFor } from '../lib/albatross/document-handoff';
import type { HandoffItem } from '../lib/albatross/goal-run-contract';
import {
  artifactBehaviour,
  documentsWaitingRows,
  itemBehaviour,
  readyForYouRows,
  type StepRunView,
} from '../lib/albatross/step-run-client';
import { handoffFixtures, stepRunFixtures } from '../lib/albatross/step-run-fixtures';
import { performNextBehaviour, type StepRunNavigatorDeps } from '../lib/albatross/step-run-navigation';
import type { ThreadRunView } from '../lib/albatross/thread-contract';
import { threadDetailFixture, threadRunFixtures } from '../lib/albatross/thread-fixtures';
import { threadState, threadStateInput } from '../lib/albatross/thread-view';

// The clients read a goal handoff's package (docs/albatross-goal-runs.md, G3):
// the Brief list, the Documents page, document mode, and the thread state.
// Invented data only.

const NOW = Date.UTC(2026, 9, 15, 15, 0);
const runs = stepRunFixtures(NOW);

const items: HandoffItem[] = [
  {
    kind: 'draft',
    id: 'd1',
    title: 'July invoice mail',
    state: 'check',
    url: '/?view=mail&account=a1&draft=d1',
    accountId: 'a1',
  },
  {
    kind: 'document',
    id: 'w1',
    title: 'Invoice 7',
    state: 'blanks',
    blanks: ['rate'],
    url: '/?view=files&office=w1',
  },
  {
    kind: 'deck',
    id: 'k1',
    title: 'Summary deck',
    state: 'check',
    url: '/?view=files&document=k1',
    note: 'Check slide 3.',
  },
  { kind: 'sheet', id: 's1', title: 'Hours', state: 'ready', url: '/?view=files&document=s1' },
  { kind: 'file', id: 'f1', title: 'W-9 filled', state: 'check', url: '/?view=files&file=f1' },
];

function goalHandoff(over: Partial<StepRunView> = {}): StepRunView {
  return {
    ...runs.readyDocument,
    id: 'run_goal',
    stepKey: 'goal',
    stepTitle: 'July invoice',
    goal: true,
    outcome: 'ready_for_you',
    next: {
      kind: 'review',
      label: 'Check the package',
      detail: 'Check each thing, then send the mail.',
      blanks: [],
      doneLabel: null,
      target: null,
      allow: null,
      saveSignIn: null,
      allowAnswer: null,
    },
    artifacts: [],
    items,
    ...over,
  };
}

describe('behaviours', () => {
  test('a deck opens as a document and a saved file opens in Files', () => {
    expect(
      artifactBehaviour({ kind: 'deck', id: 'k1', title: 'x', url: '/?view=files&document=k1' }),
    ).toEqual({
      kind: 'open_document',
      url: '/?view=files&document=k1',
      id: 'k1',
    });
    expect(artifactBehaviour({ kind: 'deck', title: 'x' })).toBeNull();
    expect(artifactBehaviour({ kind: 'file', id: 'f1', title: 'x', url: '/?view=files&file=f1' })).toEqual({
      kind: 'open_file',
      url: '/?view=files&file=f1',
      id: 'f1',
    });
    expect(
      artifactBehaviour({ kind: 'file', id: 'f1', title: 'x', url: 'https://evil.example/f1' }),
    ).toBeNull();
  });

  test('each package item opens by the path the server gave', () => {
    expect(items.map(itemBehaviour)).toEqual([
      { kind: 'open_draft', id: 'd1', accountId: 'a1' },
      { kind: 'open_document', url: '/?view=files&office=w1', id: 'w1' },
      { kind: 'open_document', url: '/?view=files&document=k1', id: 'k1' },
      { kind: 'open_document', url: '/?view=files&document=s1', id: 's1' },
      { kind: 'open_file', url: '/?view=files&file=f1', id: 'f1' },
    ]);
    expect(itemBehaviour({ kind: 'approval', id: 'ap', title: 'x', state: 'check' })).toEqual({
      kind: 'open_approval',
      id: 'ap',
    });
    expect(
      itemBehaviour({ kind: 'page', title: 'x', state: 'check', url: 'https://portal.example.com' }),
    ).toEqual({
      kind: 'open_url',
      url: 'https://portal.example.com',
    });
    expect(
      itemBehaviour({ kind: 'page', title: 'x', state: 'check', url: 'javascript:alert(1)' }),
    ).toBeNull();
    expect(itemBehaviour({ kind: 'event', id: 'e', title: 'x', state: 'ready' })).toBeNull();
    expect(itemBehaviour({ kind: 'draft', title: 'x', state: 'check' })).toBeNull();
    expect(itemBehaviour({ kind: 'document', title: 'x', state: 'check' })).toBeNull();
    expect(itemBehaviour({ kind: 'file', title: 'x', state: 'check' })).toBeNull();
  });

  test('open_file goes to Files only for a Files path', async () => {
    const calls: Array<[string, unknown]> = [];
    const views: string[] = [];
    const deps: StepRunNavigatorDeps = {
      getState: () => ({
        compose: { nonce: 1 },
        setPrimaryView: (view) => {
          views.push(view);
        },
        setPendingOpenCardId: () => undefined,
        setSelectedWorkId: () => undefined,
      }),
      setState: () => undefined,
      callTool: async () => ({}),
      openWindow: (url) => {
        calls.push(['open', url]);
      },
      pushPath: (path) => {
        calls.push(['push', path]);
      },
      dispatch: (name) => {
        calls.push(['event', name]);
      },
    };
    expect(
      await performNextBehaviour({ kind: 'open_file', url: '/?view=files&file=f1', id: 'f1' }, deps),
    ).toBe(true);
    expect(await performNextBehaviour({ kind: 'open_file', url: '//evil.example/x', id: null }, deps)).toBe(
      false,
    );
    expect(calls).toEqual([
      ['push', '/?view=files&file=f1'],
      ['event', 'lab86-mail:files-navigate'],
    ]);
    expect(views).toEqual(['files']);
  });
});

describe('the Brief and the Documents page', () => {
  test('a goal handoff whose next action opens nothing opens its first package item', () => {
    const [row] = readyForYouRows([{ workId: 'work_inv', workTitle: 'July invoice', run: goalHandoff() }]);
    expect(row.action).toEqual({
      label: 'Check the package',
      behaviour: { kind: 'open_draft', id: 'd1', accountId: 'a1' },
    });
    // A next action that opens in place wins over the package.
    const [own] = readyForYouRows([
      {
        workId: 'work_inv',
        workTitle: 'July invoice',
        run: goalHandoff({
          next: { ...goalHandoff().next!, kind: 'review_document', target: { kind: 'document', id: 'w1' } },
        }),
      },
    ]);
    expect(own.action?.behaviour).toEqual({ kind: 'open_document', url: null, id: 'w1' });
    // With no package the old rule stands: open the Work page.
    const [plain] = readyForYouRows([
      { workId: 'work_inv', workTitle: 'July invoice', run: goalHandoff({ items: [] }) },
    ]);
    expect(plain.action?.behaviour).toEqual({ kind: 'open_work' });
  });

  test('every document of a goal package that waits is a row; the old single row stays', () => {
    const rows = documentsWaitingRows([
      { workId: 'work_inv', workTitle: 'July invoice', run: goalHandoff() },
      ...handoffFixtures(NOW),
    ]);
    expect(
      rows.map((row) => [row.key, row.documentTitle, row.detail, row.blanks, row.row.action?.label]),
    ).toEqual([
      ['run_goal:w1', 'Invoice 7', 'Check each thing, then send the mail.', ['rate'], 'Open the document'],
      ['run_goal:k1', 'Summary deck', 'Check slide 3.', [], 'Open the document'],
      [runs.readyDocument.id, expect.any(String), expect.any(String), expect.any(Array), expect.any(String)],
    ]);
    expect(rows[0].row.action?.behaviour).toEqual({
      kind: 'open_document',
      url: '/?view=files&office=w1',
      id: 'w1',
    });
    // The next target's document keeps the next label.
    const named = documentsWaitingRows([
      {
        workId: 'work_inv',
        workTitle: 'July invoice',
        run: goalHandoff({
          next: { ...goalHandoff().next!, label: 'Fill in the rate', target: { kind: 'document', id: 'w1' } },
        }),
      },
    ]);
    expect(named[0].row.action?.label).toBe('Fill in the rate');
    // A stopped goal run lists no waiting documents.
    expect(
      documentsWaitingRows([{ workId: 'w', workTitle: 'x', run: goalHandoff({ outcome: 'stopped' }) }]),
    ).toEqual([]);
  });
});

describe('document mode and the thread state', () => {
  const thread = threadRunFixtures(NOW);
  const goalThreadRun = (over: Partial<ThreadRunView> = {}): ThreadRunView => ({
    ...thread.readyDraft,
    id: 'run_goal',
    stepKey: 'goal',
    goal: true,
    artifacts: [],
    items,
    question: null,
    ...over,
  });

  test('a document in a goal package belongs to that handoff', () => {
    expect(documentHandoffFor([goalThreadRun()], { provider: 'office', id: 'w1' })?.id).toBe('run_goal');
    expect(documentHandoffFor([goalThreadRun()], { provider: 'albatross', id: 'k1' })?.id).toBe('run_goal');
    expect(documentHandoffFor([goalThreadRun()], { provider: 'albatross', id: 'f1' })).toBeNull();
    // A deck the run made opens its handoff too.
    expect(
      documentHandoffFor(
        [
          goalThreadRun({
            items: [],
            artifacts: [{ kind: 'deck', id: 'k2', title: 'x', url: '/?view=files&document=k2' }],
          }),
        ],
        { provider: 'albatross', id: 'k2' },
      )?.id,
    ).toBe('run_goal');
  });

  test('a goal handoff waits on the Work even when an old plan step is open', () => {
    const detail = threadDetailFixture(NOW);
    expect(detail.execution.guideSteps.some((step) => !step.done)).toBe(true);
    const waiting = goalThreadRun({ state: 'handed_off', outcome: 'ready_for_you' });
    expect(threadState(threadStateInput(detail, [waiting]))).toBe('waiting');
    // A step run of another step does not.
    expect(threadState(threadStateInput(detail, [{ ...waiting, goal: false, stepKey: 'other-step' }]))).toBe(
      'ready',
    );
  });
});
