import { describe, expect, test } from 'bun:test';
import { threadDetailFixture, threadRunFixtures } from '../lib/albatross/thread-fixtures';
import { planStepRows, RUN_STATE_COPY } from '../lib/albatross/thread-view';

// A step whose newest run waits on the user offers no "Handle it": the plan
// row says "Your turn" (docs/albatross-thread.md, story S3).

const NOW = Date.UTC(2026, 9, 7, 18, 0);

describe('plan rows and waiting runs', () => {
  const steps = threadDetailFixture(NOW).execution.guideSteps;
  const runs = threadRunFixtures(NOW);

  test('without runs the current step is runnable', () => {
    const [first] = planStepRows(steps, { runnerEnabled: true });
    expect(first).toMatchObject({ state: 'now', runnable: true, waiting: false });
  });

  test('a handed-off run on the step makes it wait', () => {
    const waitingRun = { ...runs.needsAnswer, stepKey: steps[0].key };
    const [first] = planStepRows(steps, { runnerEnabled: true, runs: [waitingRun] });
    expect(first).toMatchObject({ runnable: false, waiting: true });
  });

  test('the newest run of the step decides', () => {
    const older = { ...runs.needsAnswer, stepKey: steps[0].key, createdAt: NOW - 60_000 };
    const newer = { ...runs.running, stepKey: steps[0].key, createdAt: NOW };
    const [first] = planStepRows(steps, { runnerEnabled: true, runs: [older, newer] });
    expect(first.waiting).toBe(false);
  });

  test('a switched-off runner offers nothing', () => {
    const [first] = planStepRows(steps, { runnerEnabled: false });
    expect(first.runnable).toBe(false);
  });
});

describe('the words of a waiting row', () => {
  const steps = threadDetailFixture(NOW).execution.guideSteps;
  const runs = threadRunFixtures(NOW);
  const label = (run: (typeof runs)[keyof typeof runs]) =>
    planStepRows(steps, { runnerEnabled: true, runs: [{ ...run, stepKey: steps[0].key }] })[0].waitingLabel;

  test('a result says Ready for you, a question Needs your answer, a page Your turn', () => {
    expect(label(runs.readyDraft)).toBe('Ready for you');
    expect(label(runs.needsAnswer)).toBe('Needs your answer');
    expect(label(runs.finalPage)).toBe('Your turn');
    expect(label(runs.stoppedTime)).toBe(RUN_STATE_COPY.yourTurn);
    expect([RUN_STATE_COPY.readyForYou, RUN_STATE_COPY.needsAnswer]).toEqual([
      'Ready for you',
      'Needs your answer',
    ]);
  });

  test('a row that does not wait has no label', () => {
    expect(label(runs.running)).toBeNull();
    expect(planStepRows(steps, { runnerEnabled: true })[0].waitingLabel).toBeNull();
    const doneStep = [{ ...steps[0], done: true }, ...steps.slice(1)];
    expect(
      planStepRows(doneStep, {
        runnerEnabled: true,
        runs: [{ ...runs.readyDraft, stepKey: steps[0].key }],
      })[0].waitingLabel,
    ).toBeNull();
  });
});

describe('saved detail labels', () => {
  test('a fixed key uses its catalog label; a custom key keeps the form label', async () => {
    const { savedDetailLabel } = await import('../components/albatross/thread/RunBlock');
    expect(savedDetailLabel({ label: 'Mobile phone', detailKey: 'phone' })).toBe('Phone');
    expect(savedDetailLabel({ label: 'Home address on file', detailKey: 'home_address' })).toBe(
      'Home address',
    );
    expect(savedDetailLabel({ label: 'Employer', detailKey: 'custom:employer' })).toBe('Employer');
    expect(savedDetailLabel({ label: 'Note' })).toBe('Note');
  });
});
