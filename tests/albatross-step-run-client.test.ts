import { describe, expect, test } from 'bun:test';
import {
  activeRunOf,
  artifactBehaviour,
  artifactKindLabel,
  blockedByOtherRun,
  browserPaneState,
  COPY,
  canStartRun,
  formatLogTime,
  handoffHeadline,
  handoffLine,
  isOpenHandoff,
  isOpenRun,
  LABEL_MAX,
  ledgerRunLabel,
  logLines,
  newestLogLine,
  nextBehaviour,
  primaryLabel,
  readyForYouRows,
  runErrorLine,
  runForStep,
  type StepRunNext,
  type StepRunView,
  showsContinue,
  stepRunPhase,
  stoppedLine,
  workingLine,
} from '../lib/albatross/step-run-client';
import { handoffFixtures, stepRunFixtures } from '../lib/albatross/step-run-fixtures';

const NOW = Date.UTC(2026, 9, 7, 14, 0, 0);
const runs = stepRunFixtures(NOW);

describe('the step run phase', () => {
  test('maps every state to a screen phase', () => {
    expect(stepRunPhase(null)).toBe('none');
    expect(stepRunPhase(runs.queued)).toBe('working');
    expect(stepRunPhase(runs.running)).toBe('working');
    expect(stepRunPhase(runs.readyDraft)).toBe('handed_off');
    expect(stepRunPhase(runs.done)).toBe('done');
    expect(stepRunPhase(runs.failed)).toBe('failed');
    expect(stepRunPhase({ ...runs.failed, state: 'cancelled' })).toBe('none');
    expect(stepRunPhase({ ...runs.readyDraft, state: 'closed' })).toBe('none');
  });

  test('open runs and open handoffs are distinct', () => {
    expect(isOpenRun(runs.queued)).toBe(true);
    expect(isOpenRun(runs.readyDraft)).toBe(false);
    expect(isOpenHandoff(runs.readyDraft)).toBe(true);
    expect(isOpenHandoff(undefined)).toBe(false);
  });
});

describe('"Handle it" eligibility', () => {
  const base = { enabled: true, runnable: true, stepDone: false, run: null, activeRun: null };

  test('needs the feature, a runnable step, and no open run on the Work', () => {
    expect(canStartRun(base)).toBe(true);
    expect(canStartRun({ ...base, enabled: false })).toBe(false);
    expect(canStartRun({ ...base, runnable: false })).toBe(false);
    expect(canStartRun({ ...base, stepDone: true })).toBe(false);
    expect(canStartRun({ ...base, activeRun: runs.running })).toBe(false);
  });

  test('a handoff or an open run on the step hides the button; a failed or closed run allows it', () => {
    expect(canStartRun({ ...base, run: runs.readyDraft })).toBe(false);
    expect(canStartRun({ ...base, run: runs.queued, activeRun: runs.queued })).toBe(false);
    expect(canStartRun({ ...base, run: runs.failed })).toBe(true);
    expect(canStartRun({ ...base, run: { ...runs.failed, state: 'cancelled' } })).toBe(true);
  });

  test('another step with the open run blocks this one', () => {
    expect(blockedByOtherRun(null, runs.running)).toBe(true);
    expect(blockedByOtherRun(runs.running, runs.running)).toBe(false);
    expect(blockedByOtherRun(null, runs.readyDraft)).toBe(false);
  });
});

describe('the live rows win over the projection', () => {
  test('runForStep prefers the subscription, then the step row', () => {
    const step = { key: 'step-1', run: runs.readyDraft };
    expect(runForStep([runs.running], step)).toBe(runs.running);
    expect(runForStep([{ ...runs.running, stepKey: 'other' }], step)).toBe(runs.readyDraft);
    expect(runForStep(undefined, { key: 'step-1' })).toBeNull();
  });

  test('activeRunOf reads the subscription when it exists, else the projection', () => {
    expect(activeRunOf([runs.readyDraft, runs.queued], null)).toBe(runs.queued);
    expect(activeRunOf([runs.readyDraft], runs.running)).toBeNull();
    expect(activeRunOf(undefined, runs.running)).toBe(runs.running);
    expect(activeRunOf(undefined, runs.readyDraft)).toBeNull();
  });
});

describe('the next action', () => {
  const next = (over: Partial<StepRunNext>): StepRunNext => ({
    kind: 'review',
    label: 'Open',
    detail: '',
    doneLabel: null,
    target: null,
    ...over,
  });

  test('maps each kind to a client behaviour', () => {
    expect(nextBehaviour(null)).toBeNull();
    expect(
      nextBehaviour(next({ kind: 'review_draft', target: { kind: 'draft', id: 'd1', accountId: 'a@b.c' } })),
    ).toEqual({ kind: 'open_draft', id: 'd1', accountId: 'a@b.c' });
    expect(nextBehaviour(next({ kind: 'review_draft' }))).toEqual({ kind: 'show_artifacts' });
    expect(
      nextBehaviour(next({ kind: 'review_document', target: { kind: 'document', url: '/files/x' } })),
    ).toEqual({
      kind: 'open_document',
      url: '/files/x',
      id: null,
    });
    expect(nextBehaviour(next({ kind: 'review_document' }))).toEqual({ kind: 'show_artifacts' });
    expect(nextBehaviour(next({ kind: 'approve', target: { kind: 'approval', id: 'ap1' } }))).toEqual({
      kind: 'open_approval',
      id: 'ap1',
    });
    expect(nextBehaviour(next({ kind: 'sign_in' }))).toEqual({ kind: 'show_browser' });
    expect(nextBehaviour(next({ kind: 'finish_on_page' }))).toEqual({ kind: 'show_browser' });
    expect(nextBehaviour(next({ kind: 'answer', target: { kind: 'question', id: 'q1' } }))).toEqual({
      kind: 'show_question',
      id: 'q1',
    });
    expect(nextBehaviour(next({ kind: 'do_offline' }))).toEqual({ kind: 'mark_done' });
    expect(nextBehaviour(next({ kind: 'review', target: { kind: 'url', url: 'https://x.y' } }))).toEqual({
      kind: 'open_url',
      url: 'https://x.y',
    });
    expect(nextBehaviour(next({ kind: 'review' }))).toEqual({ kind: 'show_artifacts' });
    expect(nextBehaviour(next({ kind: 'continue' }))).toEqual({ kind: 'resume' });
  });

  test('the agent label wins; a blank or long label falls back; answer has no button', () => {
    expect(primaryLabel(next({ kind: 'review_draft', label: 'Read and send it' }))).toBe('Read and send it');
    expect(primaryLabel(next({ kind: 'review_draft', label: '   ' }))).toBe('Read and send');
    expect(primaryLabel(next({ kind: 'sign_in', label: 'x'.repeat(LABEL_MAX + 1) }))).toBe('Sign in');
    expect(primaryLabel(next({ kind: 'finish_on_page', label: '' }))).toBe('Check and submit');
    expect(primaryLabel(next({ kind: 'approve', label: '' }))).toBe('Approve it');
    expect(primaryLabel(next({ kind: 'do_offline', label: '' }))).toBe('Mark this step done');
    expect(primaryLabel(next({ kind: 'continue', label: '' }))).toBe('Continue');
    expect(primaryLabel(next({ kind: 'review_document', label: '' }))).toBe('Open the document');
    expect(primaryLabel(next({ kind: 'answer', label: 'Answer' }))).toBeNull();
    expect(primaryLabel(null)).toBeNull();
  });

  test('only the page handoffs get a second Continue button', () => {
    expect(showsContinue(next({ kind: 'sign_in' }))).toBe(true);
    expect(showsContinue(next({ kind: 'finish_on_page' }))).toBe(true);
    expect(showsContinue(next({ kind: 'continue' }))).toBe(false);
    expect(showsContinue(null)).toBe(false);
  });
});

describe('copy', () => {
  test('the headline follows the outcome and the limit', () => {
    expect(handoffHeadline(runs.readyDraft)).toBe(COPY.readyForYou);
    expect(handoffHeadline(runs.signIn)).toBe(COPY.yourTurn);
    expect(handoffHeadline(runs.needsAnswer)).toBe(COPY.needsAnswer);
    expect(handoffHeadline(runs.stoppedTime)).toBe(COPY.stoppedTime);
    expect(handoffHeadline(runs.stoppedCost)).toBe(COPY.stoppedCost);
    expect(handoffHeadline({ outcome: 'stopped', stoppedBy: null })).toBe(COPY.stopped);
    expect(handoffHeadline({ outcome: null, stoppedBy: null })).toBe(COPY.handedOff);
    expect(stoppedLine({ stoppedBy: 'time' })).toBe(COPY.stoppedTime);
  });

  test('the log reads oldest first and the working line is its newest line', () => {
    const shuffled: StepRunView = {
      ...runs.running,
      log: [...runs.running.log].reverse(),
    };
    expect(logLines(shuffled).map((line) => line.text)).toEqual(runs.running.log.map((line) => line.text));
    expect(newestLogLine(runs.running)).toBe('Filled the policy number and the claim reference');
    expect(workingLine(runs.running)).toBe('Filled the policy number and the claim reference');
    expect(workingLine(runs.queued)).toBe(COPY.queued);
    expect(workingLine({ state: 'running', log: [] })).toBe(COPY.working);
    expect(newestLogLine({ log: [] })).toBeNull();
  });

  test('the error line and the list line have fallbacks', () => {
    expect(runErrorLine(runs.failed)).toBe('The insurer site did not load after three tries.');
    expect(runErrorLine({ error: '  ' })).toBe(COPY.failed);
    expect(handoffLine(runs.readyDraft)).toBe(runs.readyDraft.summary as string);
    expect(handoffLine({ ...runs.signIn, summary: null })).toBe(runs.signIn.next!.detail as string);
    expect(handoffLine({ ...runs.stoppedCost, summary: null, next: null })).toBe(COPY.stoppedCost);
  });

  test('log times format in the given zone', () => {
    expect(formatLogTime(NOW, 'en-US', 'UTC')).toBe('2:00 PM');
  });

  test('the ledger label is short', () => {
    expect(ledgerRunLabel(runs.running)).toBe('Albatross is on it');
    expect(ledgerRunLabel(runs.readyDraft)).toBe(COPY.readyForYou);
    expect(ledgerRunLabel(runs.failed)).toBe('Run did not finish');
    expect(ledgerRunLabel(runs.done)).toBeNull();
    expect(ledgerRunLabel(null)).toBeNull();
  });
});

describe('artifacts', () => {
  test('rows open what they can and stay text otherwise', () => {
    expect(artifactBehaviour({ kind: 'draft', id: 'd1', title: 'x', accountId: 'a' })).toEqual({
      kind: 'open_draft',
      id: 'd1',
      accountId: 'a',
    });
    expect(artifactBehaviour({ kind: 'draft', title: 'x' })).toBeNull();
    expect(artifactBehaviour({ kind: 'document', id: 'doc', title: 'x', url: '/files/doc' })).toEqual({
      kind: 'open_document',
      url: '/files/doc',
      id: 'doc',
    });
    expect(artifactBehaviour({ kind: 'approval', id: 'ap', title: 'x' })).toEqual({
      kind: 'open_approval',
      id: 'ap',
    });
    expect(artifactBehaviour({ kind: 'page', title: 'x', url: 'https://x.y' })).toEqual({
      kind: 'open_url',
      url: 'https://x.y',
    });
    expect(artifactBehaviour({ kind: 'page', title: 'x' })).toBeNull();
    expect(artifactBehaviour({ kind: 'card', id: 'c1', title: 'x' })).toEqual({
      kind: 'open_card',
      id: 'c1',
    });
    expect(artifactBehaviour({ kind: 'event', id: 'e1', title: 'x' })).toBeNull();
    expect(artifactKindLabel({ kind: 'card' })).toBe('Task');
    expect(artifactKindLabel({ kind: 'document' })).toBe('Document');
  });
});

describe('the Brief list', () => {
  test('a run at work has no button; a file handoff opens the file; the rest open the Work', () => {
    const rows = readyForYouRows(handoffFixtures(NOW));
    expect(rows.map((row) => row.workId)).toEqual(['work_claim', 'work_lease', 'work_bank', 'work_plans']);
    expect(rows[0]).toMatchObject({
      working: true,
      stepTitle: 'In progress: Send the dispute letter to the insurer',
      line: 'Filled the policy number and the claim reference',
      action: null,
    });
    expect(rows[1].action).toEqual({
      label: 'Open the document',
      behaviour: { kind: 'open_document', url: '/files/doc_lease', id: 'doc_lease' },
    });
    expect(rows[2].action).toEqual({ label: 'Sign in', behaviour: { kind: 'open_work' } });
    expect(rows[3].action).toEqual({ label: 'Continue', behaviour: { kind: 'resume' } });
    expect(rows[3].line).toBe(runs.stoppedTime.summary as string);
  });

  test('done, failed, and closed runs do not make rows; a missing label says Open', () => {
    const rows = readyForYouRows([
      { workId: 'a', workTitle: 'A', run: runs.done },
      { workId: 'b', workTitle: 'B', run: runs.failed },
      { workId: 'c', workTitle: 'C', run: { ...runs.readyDraft, state: 'closed' } },
      { workId: 'd', workTitle: 'D', run: { ...runs.stoppedCost, next: null } },
    ]);
    expect(rows.map((row) => row.workId)).toEqual(['d']);
    expect(rows[0].action).toEqual({ label: 'Open', behaviour: { kind: 'open_work' } });
  });
});

describe('the shared browser bar', () => {
  test('the agent has the page: the detail line and Take over while the run is open', () => {
    expect(browserPaneState({ status: 'agent', statusDetail: 'Opening the form' }, runs.running)).toEqual({
      line: 'Opening the form',
      action: 'take_over',
    });
    expect(browserPaneState({ status: 'agent', statusDetail: '' }, runs.readyDraft)).toEqual({
      line: COPY.agentHasPage,
      action: null,
    });
  });

  test('the user has the page after a sign-in handoff: the handoff detail and Continue', () => {
    expect(browserPaneState({ status: 'user' }, runs.signIn)).toEqual({
      line: runs.signIn.next!.detail,
      action: 'continue',
    });
    expect(
      browserPaneState({ status: 'user' }, { ...runs.signIn, next: { ...runs.signIn.next!, detail: ' ' } }),
    ).toEqual({
      line: COPY.userHasPage,
      action: 'continue',
    });
  });

  test('otherwise the usual guided line applies', () => {
    expect(browserPaneState({ status: 'user' }, runs.readyDraft)).toBeNull();
    expect(browserPaneState({ status: 'verifying' }, runs.running)).toBeNull();
    expect(browserPaneState(null, runs.running)).toBeNull();
  });
});
