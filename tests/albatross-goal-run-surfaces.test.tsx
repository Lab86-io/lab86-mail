import { describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { renderToStaticMarkup } from 'react-dom/server';
import { DetailsPanel } from '../components/albatross/thread/DetailsPanel';
import { GoalIntro, PlanIntro } from '../components/albatross/thread/PlanIntro';
import { steerRunLabel, ThreadRouteLine } from '../components/albatross/thread/ThreadSteering';
import { artifactBehaviour, documentsWaitingRows, readyForYouRows } from '../lib/albatross/step-run-client';
import { openSavedFilePath } from '../lib/albatross/step-run-navigation';
import {
  GOAL_FIXTURE_WORK_ID,
  goalDetailFixture,
  goalDetailWithEarlierSteps,
  goalRunFixtures,
  threadRunFixtures,
} from '../lib/albatross/thread-fixtures';
import { planStepRows } from '../lib/albatross/thread-view';
import { type ThreadWorkInput, threadRow } from '../lib/albatross/threads';

/* The surfaces around the goal run block: the intro with "Handle it" and the
 * earlier steps, the composer route line, the Details panel sections, the
 * Brief and Documents rows, the saved-file artifact, and the rail preview. */

const NOW = Date.UTC(2026, 9, 15, 18, 44, 0);
const runs = goalRunFixtures(NOW);
const noop = () => undefined;
const dom = (html: string) => new JSDOM(html).window.document;

describe('the intro of a goal Work', () => {
  test('Handle it with no step, and the earlier steps folded', () => {
    const detail = goalDetailWithEarlierSteps(NOW);
    const steps = planStepRows(detail.execution.guideSteps, { runnerEnabled: true });
    const doc = dom(
      renderToStaticMarkup(
        <PlanIntro
          outcome="Invoice Bramble Press for July"
          summary={detail.plan?.summary}
          steps={steps}
          state="ready"
          goal={{ showHandle: true, onHandle: noop }}
        />,
      ),
    );
    expect(doc.body.textContent).toContain('2 steps done before this');
    expect([...doc.querySelectorAll('button')].map((button) => button.textContent)).toContain('Handle it');
    expect(doc.querySelector('[data-slot="plan-steps"]')).toBeNull();
    expect(doc.body.textContent).not.toContain('Step 1 of');
  });

  test('nothing when a run is open and no steps came before', () => {
    expect(renderToStaticMarkup(<GoalIntro earlierSteps={[]} showHandle={false} onHandle={noop} />)).toBe('');
  });
});

describe('the composer route line of a goal run', () => {
  test('says To the run alone', () => {
    const run = {
      id: 'run_goal_running',
      stepTitle: 'Invoice Bramble Press for July',
      stepNumber: null,
      goal: true,
    };
    expect(steerRunLabel(run)).toBe('');
    const doc = dom(
      renderToStaticMarkup(
        <ThreadRouteLine mode="run" run={run} onStopAndRedirect={noop} onCancelRedirect={noop} />,
      ),
    );
    const line = doc.querySelector('[data-thread-route="run"]')!;
    expect(line.textContent).toContain('To the run');
    expect(line.textContent).not.toContain('·');
    expect(line.textContent).not.toContain('Invoice Bramble Press');
    expect(steerRunLabel({ stepTitle: 'Renew online', stepNumber: 2 })).toBe('Step 2, Renew online');
  });
});

describe('the Details panel of a goal Work', () => {
  const detail = goalDetailFixture(NOW);
  const base = {
    detail,
    steps: [],
    undoneOperations: new Set<string>(),
    undoing: null,
    onUndo: noop,
    onError: noop,
  };

  test('Checklist, Package, and Sources replace the Plan', () => {
    const doc = dom(
      renderToStaticMarkup(
        <DetailsPanel
          {...base}
          goal={{ run: runs.goalPackage, packageRun: runs.goalPackage, onOpenItem: noop, onOpenSource: noop }}
        />,
      ),
    );
    const headings = [...doc.querySelectorAll('h2')].map((node) => node.textContent);
    expect(headings.some((text) => text?.startsWith('Checklist'))).toBe(true);
    expect(headings.some((text) => text?.startsWith('Package'))).toBe(true);
    expect(headings.some((text) => text?.startsWith('Sources'))).toBe(true);
    expect(headings).not.toContain('Plan');
    expect(doc.querySelector('[data-slot="checklist"]')?.getAttribute('aria-label')).toBe(
      'Checklist, 6 of 7 done',
    );
    expect(doc.querySelectorAll('[data-slot="package-rows"] li').length).toBe(4);
    const sources = [...doc.querySelectorAll('[data-slot="details-sources"] li')];
    expect(sources.length).toBe(5);
    expect(sources[0].textContent).toContain('1');
    expect(sources[0].textContent).toContain('BP-214 worklog, July');
    expect(sources[4].textContent).toContain('irs.gov');
    for (const source of sources) expect(source.textContent).not.toContain('·');
  });

  test('the empty copy before the first run', () => {
    const doc = dom(renderToStaticMarkup(<DetailsPanel {...base} goal={{ run: null, packageRun: null }} />));
    expect(doc.body.textContent).toContain('No checklist yet. It appears when a run starts.');
    expect(doc.body.textContent).toContain('Nothing handed over yet.');
    expect(doc.body.textContent).toContain('No sources yet.');
  });
});

describe('the Brief and the Documents page', () => {
  const item = {
    workId: GOAL_FIXTURE_WORK_ID,
    workTitle: 'Invoice Bramble Press for July',
    run: runs.goalPackage,
  };

  test('Ready for you names the items and opens the thread', () => {
    const rows = readyForYouRows([item]);
    expect(rows[0].line).toBe(
      '4 items: Invoice 0007 to Priya Natarajan, Invoice 0007, Hours, July, Form W-9, filled',
    );
    expect(rows[0].action).toEqual({ label: 'Open the package', behaviour: { kind: 'open_work' } });
  });

  test('Waiting for you lists each item that still needs the user', () => {
    const rows = documentsWaitingRows([item]);
    expect(rows.map((row) => row.documentTitle)).toEqual(['Invoice 0007', 'Form W-9, filled']);
    expect(rows[0].blanks).toEqual(['rate']);
    expect(rows[1].detail).toBe('The tax ID fills in when you send.');
    expect(rows[1].itemId).toBe('upload_w9_filled');
  });

  test('a step handoff keeps its one row', () => {
    const steps = threadRunFixtures(NOW);
    const stepItem = { workId: 'work_alive25', workTitle: 'CPR', run: steps.readyDraft };
    expect(readyForYouRows([stepItem])[0].action?.label).toBe('Read and send');
    expect(documentsWaitingRows([stepItem])).toEqual([]);
  });
});

describe('saved files', () => {
  test('a file artifact opens from the link the server wrote, a deck from its document', () => {
    expect(
      artifactBehaviour({ kind: 'file', id: 'upload_1', url: '/?view=files&file=upload_1', title: 'W-9' }),
    ).toEqual({ kind: 'open_file', url: '/?view=files&file=upload_1', id: 'upload_1' });
    expect(artifactBehaviour({ kind: 'file', id: 'upload_1', title: 'W-9' })).toBeNull();
    expect(artifactBehaviour({ kind: 'deck', id: 'doc_deck', title: 'Deck' })).toEqual({
      kind: 'open_document',
      url: null,
      id: 'doc_deck',
    });
  });

  test('the Files link opens only for an app link with a file id', () => {
    const pushed: string[] = [];
    const views: string[] = [];
    const deps = {
      getState: () => ({ setPrimaryView: (view: string) => views.push(view) }) as never,
      pushPath: (path: string) => pushed.push(path),
      dispatch: noop,
    };
    expect(openSavedFilePath(deps, '/?view=files&file=upload 1')).toBe(true);
    expect(pushed).toEqual(['/?view=files&file=upload%201']);
    expect(views).toEqual(['files']);
    expect(openSavedFilePath(deps, 'https://evil.example.com/?view=files&file=x')).toBe(false);
    expect(openSavedFilePath(deps, '/?view=files')).toBe(false);
    expect(openSavedFilePath(deps, null)).toBe(false);
  });
});

describe('the rail preview', () => {
  const work: ThreadWorkInput = {
    _id: GOAL_FIXTURE_WORK_ID,
    title: 'Invoice Bramble Press for July',
    status: 'ready',
    workState: 'active',
    updatedAt: NOW - 60_000,
  } as ThreadWorkInput;
  const activity = (over: Record<string, unknown>) =>
    ({
      runId: 'run_1',
      state: 'running',
      outcome: null,
      stepTitle: 'Invoice Bramble Press for July',
      logLine: 'Read the BP-214 worklog for July',
      nextKind: null,
      nextLabel: null,
      nextDetail: null,
      nextBlanks: [],
      allowAnswered: false,
      summary: null,
      error: null,
      stoppedBy: null,
      startedAt: NOW - 60_000,
      finishedAt: null,
      createdAt: NOW - 60_000,
      updatedAt: NOW - 30_000,
      ...over,
    }) as never;

  test('reads the doing item and the message when the server sends them, else the log line', () => {
    expect(threadRow(work, activity({ doing: 'Find the July hours' }), null).preview).toBe(
      'Find the July hours',
    );
    expect(threadRow(work, activity({ message: 'I look for the hours.' }), null).preview).toBe(
      'I look for the hours.',
    );
    expect(threadRow(work, activity({}), null).preview).toBe('Read the BP-214 worklog for July');
  });

  test('a package names its items', () => {
    const row = threadRow(
      work,
      activity({
        state: 'handed_off',
        outcome: 'ready_for_you',
        nextDetail: 'Fill in the rate.',
        items: [{ title: 'Draft' }, { title: 'Invoice 0007' }],
      }),
      null,
    );
    expect(row.preview).toBe('2 items: Draft, Invoice 0007');
    const counted = threadRow(
      work,
      activity({
        state: 'handed_off',
        outcome: 'ready_for_you',
        goal: true,
        itemCount: 4,
        nextDetail: 'Fill in the rate.',
      }),
      null,
    );
    expect(counted.preview).toBe('4 items. Fill in the rate.');
  });
});
