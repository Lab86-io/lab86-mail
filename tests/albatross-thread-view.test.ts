import { describe, expect, test } from 'bun:test';
import { PERSONAL_DETAIL_LABELS, type ThreadRunView } from '../lib/albatross/thread-contract';
import {
  classQuestionForm,
  threadDetailDoneStep,
  threadDetailFixture,
  threadDetailsFixture,
  threadMessagesFixture,
  threadRunFixtures,
} from '../lib/albatross/thread-fixtures';
import {
  accountNameHint,
  answerTextRows,
  composerPlaceholder,
  detailSourceLine,
  detailValueForField,
  fieldsToSave,
  formReceiptRows,
  formValueDisplay,
  jumpPillLabel,
  logDisclosure,
  messageCreatedAt,
  pendingFormVisibleIn,
  personalDetailRows,
  planLine,
  planStepRows,
  prefillForm,
  questionReceiptLine,
  RUN_STATE_COPY,
  runBlockAction,
  runBlockDismisses,
  runBlockMarksDone,
  runStateLine,
  runUsesPage,
  saveBoxLabel,
  savedCountLine,
  savedLabelsFromAnswer,
  startedRunIds,
  stepNumberFor,
  stoppedReason,
  type ThreadStateInput,
  threadState,
  threadStateInput,
} from '../lib/albatross/thread-view';

const NOW = Date.UTC(2026, 9, 7, 14, 46, 0);
const runs = threadRunFixtures(NOW);

describe('the run block state line', () => {
  test('uses no -ing forms and one word per state', () => {
    expect(runStateLine(runs.queued)).toEqual({ text: 'Starts soon', tone: 'working' });
    expect(runStateLine(runs.running)).toEqual({ text: 'In progress', tone: 'working' });
    expect(runStateLine(runs.needsAnswer)).toEqual({ text: 'Needs your answer', tone: 'waiting' });
    expect(runStateLine(runs.answeredForm)).toEqual({ text: 'Answered', tone: 'quiet' });
    expect(runStateLine(runs.signIn)).toEqual({ text: 'Your turn', tone: 'waiting' });
    expect(runStateLine(runs.readyDraft)).toEqual({ text: 'Ready for you', tone: 'waiting' });
    expect(runStateLine(runs.stoppedTime)).toEqual({ text: 'Stopped', tone: 'quiet' });
    expect(runStateLine(runs.done)).toEqual({ text: 'Done', tone: 'done' });
    expect(runStateLine(runs.failed)).toEqual({ text: 'Did not finish', tone: 'failed' });
    expect(runStateLine(runs.cancelled)).toEqual({ text: 'Stopped by you', tone: 'quiet' });
    for (const value of Object.values(RUN_STATE_COPY)) expect(value).not.toMatch(/\b\w+ing\b/i);
  });

  test('names the limit a stopped run hit', () => {
    expect(stoppedReason(runs.stoppedTime)).toBe('Albatross stopped at its time limit.');
    expect(stoppedReason({ outcome: 'stopped', stoppedBy: 'cost' })).toBe(
      'Albatross stopped at its cost limit.',
    );
    expect(stoppedReason(runs.done)).toBeNull();
  });

  test('the log disclosure is "What Albatross did" with a quiet count and no unit word', () => {
    expect(logDisclosure(6)).toEqual({ label: 'What Albatross did', count: '6' });
    expect(logDisclosure(0)).toEqual({ label: 'What Albatross did', count: null });
  });
});

describe('the primary action of a run block', () => {
  test('a run at work offers Stop; a question has no button of its own', () => {
    expect(runBlockAction(runs.running)).toEqual({ kind: 'stop' });
    expect(runBlockAction(runs.queued)).toEqual({ kind: 'stop' });
    expect(runBlockAction(runs.needsAnswer)).toEqual({ kind: 'none' });
  });

  test("the user's turn on a page uses the done label and resumes the run", () => {
    expect(runBlockAction(runs.finalPage)).toEqual({ kind: 'resume', label: 'I paid' });
    expect(runBlockAction(runs.signIn)).toEqual({ kind: 'resume', label: 'I signed in' });
    expect(runBlockAction({ ...runs.signIn, next: { ...runs.signIn.next!, doneLabel: null } })).toEqual({
      kind: 'resume',
      label: 'Continue',
    });
  });

  test('a draft handoff opens the draft; a stopped run continues; a failed run restarts only when it may', () => {
    expect(runBlockAction(runs.readyDraft)).toMatchObject({ kind: 'next', label: 'Read and send' });
    expect(runBlockAction(runs.stoppedTime)).toEqual({ kind: 'resume', label: 'Continue' });
    expect(runBlockAction(runs.failed)).toEqual({ kind: 'none' });
    expect(runBlockAction(runs.failed, { startable: true })).toEqual({ kind: 'start', label: 'Try again' });
    expect(runBlockAction(runs.cancelled, { startable: true })).toEqual({
      kind: 'start',
      label: 'Handle it',
    });
  });

  test('Dismiss shows on every open handoff and nowhere else', () => {
    expect(runBlockDismisses(runs.needsAnswer)).toBe(true);
    expect(runBlockDismisses(runs.answeredForm)).toBe(false);
    expect(runBlockDismisses(runs.finalPage)).toBe(true);
    expect(runBlockDismisses(runs.running)).toBe(false);
    expect(runBlockDismisses(runs.done)).toBe(false);
  });

  test('a run uses the page while it works or waits on a sign-in or a final page', () => {
    expect(runUsesPage(runs.running)).toBe(true);
    expect(runUsesPage(runs.signIn)).toBe(true);
    expect(runUsesPage(runs.finalPage)).toBe(true);
    expect(runUsesPage(runs.needsAnswer)).toBe(false);
    expect(runUsesPage(runs.done)).toBe(false);
  });
});

describe('the thread state and the plan line', () => {
  const detail = threadDetailFixture(NOW);

  test('reads the state from the detail and the runs', () => {
    expect(threadState(threadStateInput(detail, []))).toBe('ready');
    expect(threadState(threadStateInput(detail, [runs.running]))).toBe('running');
    expect(threadState(threadStateInput(detail, [runs.needsAnswer]))).toBe('needs_answer');
    expect(threadState(threadStateInput(detail, [runs.finalPage]))).toBe('waiting');
    expect(
      threadState(
        threadStateInput({ ...detail, plan: null, execution: { ...detail.execution, guideSteps: [] } }, []),
      ),
    ).toBe('planning');
    expect(
      threadState(threadStateInput({ ...detail, work: { ...detail.work, workState: 'done' } }, [])),
    ).toBe('done');
    expect(
      threadState(threadStateInput({ ...detail, work: { ...detail.work, workState: 'released' } }, [])),
    ).toBe('released');
  });

  test('writes "Step N of M · State"', () => {
    expect(planLine(threadStateInput(detail, [])).text).toBe('Step 1 of 2 · Your move');
    expect(planLine(threadStateInput(detail, [runs.running])).text).toBe('Step 1 of 2 · In progress');
    expect(planLine(threadStateInput(detail, [runs.needsAnswer])).text).toBe(
      'Step 1 of 2 · Needs your answer',
    );
    expect(planLine(threadStateInput(detail, [runs.finalPage])).text).toBe('Step 1 of 2 · Your turn');
    expect(planLine(threadStateInput(detail, [runs.readyDraft])).text).toBe('Step 1 of 2 · Your move');
    expect(planLine(threadStateInput(threadDetailDoneStep(NOW), [])).text).toBe('Step 2 of 2 · Your move');
    expect(
      planLine(
        threadStateInput({ ...detail, plan: null, execution: { ...detail.execution, guideSteps: [] } }, []),
      ).text,
    ).toBe('Making the plan…');
    expect(
      planLine(threadStateInput({ ...detail, work: { ...detail.work, workState: 'done' } }, [])).text,
    ).toBe('Done');
  });

  test('an answered question no longer waits', () => {
    expect(threadState(threadStateInput(detail, [runs.answeredChat]))).toBe('ready');
  });

  test('the composer placeholder follows the state', () => {
    expect(composerPlaceholder('needs_answer')).toBe('Answer here, or tell Albatross what to change');
    expect(composerPlaceholder('running')).toBe('Tell Albatross what to change');
    expect(composerPlaceholder('ready')).toBe('Tell Albatross what to do');
    expect(composerPlaceholder('waiting')).toBe('Tell Albatross what to do');
    expect(composerPlaceholder('planning')).toBe('Add anything Albatross should know');
    expect(composerPlaceholder('done')).toBe('Ask about this Albatross');
  });

  test('the jump pill says Newest, or that an answer waits off screen', () => {
    expect(jumpPillLabel({ atBottom: true, pendingFormVisible: null })).toBeNull();
    expect(jumpPillLabel({ atBottom: false, pendingFormVisible: null })).toBe('Newest');
    expect(jumpPillLabel({ atBottom: true, pendingFormVisible: false })).toBe('Albatross needs an answer');
    expect(jumpPillLabel({ atBottom: false, pendingFormVisible: true })).toBe('Newest');
  });

  test('plan step rows mark done, now, next, and yours', () => {
    const rows = planStepRows(detail.execution.guideSteps, { runnerEnabled: true });
    expect(rows.map((row) => row.state)).toEqual(['now', 'yours']);
    expect(rows[0].runnable).toBe(true);
    expect(rows[1].runnable).toBe(false);
    const done = planStepRows(threadDetailDoneStep(NOW).execution.guideSteps, { runnerEnabled: true });
    expect(done[0]).toMatchObject({
      state: 'done',
      proof: 'Verified on the page · Registration confirmed, order A1234',
    });
    expect(stepNumberFor(detail.execution.guideSteps, 'step-2')).toBe(2);
    expect(stepNumberFor(detail.execution.guideSteps, 'missing')).toBeNull();
  });
});

describe('the timeline readers', () => {
  test('read the message time and the runs a message started', () => {
    const messages = threadMessagesFixture(NOW, 'run_running');
    expect(messageCreatedAt(messages[0])).toBe(NOW - 7 * 60_000);
    expect(messageCreatedAt({ metadata: {} })).toBeNull();
    expect(messageCreatedAt(null)).toBeNull();
    expect(startedRunIds(messages[1])).toEqual(['run_running']);
    expect(startedRunIds(messages[0])).toEqual([]);
    // A steered note does not own the run.
    const steered = {
      parts: [{ type: 'data-tool-shape', data: { kind: 'step_run', runId: 'r', action: 'steered' } }],
    };
    expect(startedRunIds(steered)).toEqual([]);
  });
});

describe('form prefill and the save box', () => {
  const details = threadDetailsFixture(NOW).details;

  test('fills bound fields from the saved details and preselects the recommended option', () => {
    const { values, prefilled } = prefillForm(classQuestionForm, details);
    expect(values.class).toEqual({ choices: ['mon-19'] });
    expect(values.name).toEqual({ first: 'Sam', last: 'Rivera' });
    expect(values.email).toBe('sam.rivera@example.com');
    expect(prefilled.name).toMatchObject({ source: 'From your details', saved: true });
    expect(prefilled.email).toMatchObject({ source: 'From your account', saved: true });
    expect(values.phone).toBeUndefined();
    expect(prefilled.phone).toBeUndefined();
  });

  test("a value the run found shows the run's own source line", () => {
    const form = {
      ...classQuestionForm,
      fields: [
        {
          id: 'phone',
          label: 'Phone',
          kind: 'phone' as const,
          detailKey: 'phone',
          value: '555 555 0100',
          valueSource: 'From your email signature',
        },
      ],
    };
    const { values, prefilled } = prefillForm(form, details);
    expect(values.phone).toBe('555 555 0100');
    expect(prefilled.phone).toEqual({
      value: '555 555 0100',
      source: 'From your email signature',
      saved: false,
    });
    expect(fieldsToSave(form, values, prefilled).map((field) => field.id)).toEqual(['phone']);
  });

  test('only a new or changed bound value is offered for saving', () => {
    const { values, prefilled } = prefillForm(classQuestionForm, details);
    expect(fieldsToSave(classQuestionForm, values, prefilled)).toEqual([]);
    const typed = { ...values, phone: '(555) 555-0100' };
    expect(fieldsToSave(classQuestionForm, typed, prefilled).map((field) => field.id)).toEqual(['phone']);
    const changedName = { ...typed, name: { first: 'Samuel', last: 'Rivera' } };
    expect(fieldsToSave(classQuestionForm, changedName, prefilled).map((field) => field.id)).toEqual([
      'name',
      'phone',
    ]);
    expect(saveBoxLabel(fieldsToSave(classQuestionForm, typed, prefilled))).toBe('Save phone to my details');
    expect(saveBoxLabel(fieldsToSave(classQuestionForm, changedName, prefilled))).toBe(
      'Save name and phone to my details',
    );
    expect(saveBoxLabel([])).toBe('Save to my details');
  });

  test('detail values map to field kinds, never across kinds', () => {
    const phoneField = { id: 'p', label: 'Phone', kind: 'phone' as const, detailKey: 'name' };
    expect(detailValueForField(phoneField, details[0])).toBeNull();
    expect(detailValueForField({ ...phoneField, detailKey: 'email' }, details[1])).toBe(
      'sam.rivera@example.com',
    );
  });
});

describe('the answered receipt', () => {
  test('shows one line per answered field', () => {
    const rows = formReceiptRows(classQuestionForm, {
      class: { choices: ['mon-19'] },
      phone: '+15555550100',
      name: { first: 'Sam', last: 'Rivera' },
      address: {
        line1: '12 Elm Street',
        line2: 'Apt 3',
        city: 'Springfield',
        region: 'IL',
        postalCode: '62704',
        country: 'US',
      },
    });
    expect(rows).toEqual([
      { id: 'class', label: 'Class', value: 'Monday, October 19' },
      { id: 'name', label: 'Name', value: 'Sam Rivera' },
      { id: 'address', label: 'Home address', value: '12 Elm Street, Apt 3, Springfield, IL 62704' },
      { id: 'phone', label: 'Phone', value: '(555) 555-0100' },
    ]);
    expect(
      formValueDisplay(classQuestionForm.fields[0], { choices: ['wed-21'], other: 'or any evening' }),
    ).toBe('Wednesday, October 21, or any evening');
    expect(formValueDisplay(classQuestionForm.fields[4], undefined)).toBe('—');
  });

  test('reads the state line and the rows back from a recorded answer', () => {
    expect(questionReceiptLine(runs.answeredForm.question!, '10:44')).toBe('Answered 10:44');
    expect(questionReceiptLine(runs.answeredChat.question!)).toBe('Answered in the chat.');
    expect(questionReceiptLine({ status: 'dismissed', answeredIn: null })).toBe('Skipped');
    expect(questionReceiptLine({ status: 'superseded', answeredIn: null })).toBe('No longer open');
    expect(answerTextRows(runs.answeredChat.question!.answer)).toEqual([
      { id: 'line-0', label: 'Class', value: 'Monday, October 19 (4:00–8:00 PM · Zoom · $45)' },
      { id: 'line-1', label: 'Phone', value: '(555) 555-0100' },
    ]);
    expect(savedLabelsFromAnswer(runs.answeredForm.question!.answer)).toEqual(['Phone']);
    expect(savedLabelsFromAnswer('Class: Monday')).toEqual([]);
  });
});

describe('personal details rows', () => {
  const response = threadDetailsFixture(NOW);

  test('lists saved and default details, then the missing fixed keys', () => {
    const rows = personalDetailRows(response, PERSONAL_DETAIL_LABELS);
    expect(rows.map((row) => row.key)).toEqual([
      'name',
      'email',
      'home_address',
      'phone',
      'emergency_contact',
    ]);
    expect(rows[3]).toMatchObject({ label: 'Phone', detail: null });
    expect(personalDetailRows(null, PERSONAL_DETAIL_LABELS)).toEqual([]);
    expect(savedCountLine(response.details)).toBe('2 saved');
    expect(savedCountLine([])).toBeNull();
  });

  test('says where each detail came from, with the date', () => {
    expect(detailSourceLine(response.details[1], { timeZone: 'UTC' })).toBe('From your account');
    expect(detailSourceLine(response.details[0], { timeZone: 'UTC' })).toBe('You changed this on Oct 4');
    expect(detailSourceLine(response.details[2], { timeZone: 'UTC' })).toBe('From a form on Oct 6');
    expect(detailSourceLine({ source: 'chat', updatedAt: NOW, saved: true }, { timeZone: 'UTC' })).toBe(
      'You told Albatross on Oct 7',
    );
    expect(detailSourceLine({ source: 'chat', updatedAt: null, saved: true })).toBe('You told Albatross');
  });

  test('the legal-name hint names the account name only when it differs', () => {
    expect(accountNameHint(response.details[0], 'Sam rivera')).toBe('Account name: Sam rivera');
    expect(accountNameHint(response.details[0], 'Sam Rivera')).toBeNull();
    expect(accountNameHint(response.details[0], null)).toBeNull();
    expect(accountNameHint(response.details[1], 'Other Name')).toBeNull();
    expect(accountNameHint({ key: 'name', display: 'Sam Rivera', source: 'account' }, 'Other')).toBeNull();
  });
});

describe('the pending form against the chat viewport', () => {
  const viewport = { top: 100, bottom: 700 };
  test('counts as visible when enough of the card is inside the viewport', () => {
    expect(pendingFormVisibleIn(viewport, { top: 200, bottom: 600 })).toBe(true);
    expect(pendingFormVisibleIn(viewport, { top: 650, bottom: 1200 })).toBe(false);
    expect(pendingFormVisibleIn(viewport, { top: 620, bottom: 1200 })).toBe(false);
    expect(pendingFormVisibleIn(viewport, { top: 600, bottom: 1200 })).toBe(true);
    expect(pendingFormVisibleIn(viewport, { top: -500, bottom: 150 })).toBe(false);
  });
  test('a short card only needs its own height', () => {
    expect(pendingFormVisibleIn(viewport, { top: 680, bottom: 700 })).toBe(true);
  });
});

// Every result that waits for the user can be marked done
// (docs/albatross-document-handoff.md, D2). Story: the Harbor Design studio
// hours invoice.
describe('a ready-for-you result and Mark step done', () => {
  const base = runs.readyDraft;
  function handoff(
    outcome: 'ready_for_you' | 'your_turn',
    next: Partial<NonNullable<ThreadRunView['next']>>,
  ) {
    return {
      ...base,
      outcome,
      next: {
        ...base.next!,
        label: '',
        detail: 'Fill in the hours.',
        target: null,
        ...next,
      },
    } as ThreadRunView;
  }

  test('a result the button can open keeps the agent label, and Mark step done is the second button', () => {
    const openable = [
      handoff('ready_for_you', {
        kind: 'review_document',
        label: 'Fill in hours',
        target: { kind: 'document', id: 'doc_invoice' },
      }),
      handoff('ready_for_you', { kind: 'review_draft', target: { kind: 'draft', id: 'draft_invoice' } }),
      handoff('ready_for_you', {
        kind: 'review',
        target: { kind: 'url', url: 'https://example.com/portal' },
      }),
      handoff('ready_for_you', { kind: 'approve', target: { kind: 'approval', id: 'approval_1' } }),
    ];
    expect(runBlockAction(openable[0])).toMatchObject({
      kind: 'next',
      label: 'Fill in hours',
      behaviour: { kind: 'open_document', id: 'doc_invoice' },
    });
    expect(runBlockAction(openable[1])).toMatchObject({
      kind: 'next',
      label: 'Read and send',
      behaviour: { kind: 'open_draft', id: 'draft_invoice' },
    });
    expect(runBlockAction(openable[2])).toMatchObject({
      kind: 'next',
      behaviour: { kind: 'open_url', url: 'https://example.com/portal' },
    });
    expect(runBlockAction(openable[3])).toMatchObject({ kind: 'next', behaviour: { kind: 'open_approval' } });
    for (const run of openable) expect(runBlockMarksDone(run)).toBe(true);
    expect(runBlockMarksDone(base)).toBe(true);
  });

  test('a result with nothing to open has Mark step done as its one primary button', () => {
    const closed = [
      handoff('ready_for_you', { kind: 'review' }),
      handoff('ready_for_you', { kind: 'review_document' }),
      handoff('ready_for_you', { kind: 'review_draft' }),
    ];
    for (const run of closed) {
      expect(runBlockAction(run)).toEqual({ kind: 'mark_done', label: RUN_STATE_COPY.markDone });
      expect(runBlockMarksDone(run)).toBe(false);
    }
    expect(RUN_STATE_COPY.markDone).toBe('Mark step done');
  });

  test('the user turn is not changed', () => {
    const document = handoff('your_turn', {
      kind: 'review_document',
      label: 'Fill in hours',
      target: { kind: 'document', id: 'doc_invoice' },
    });
    expect(runBlockAction(document)).toMatchObject({ kind: 'next', label: 'Fill in hours' });
    expect(runBlockMarksDone(document)).toBe(false);
    const review = handoff('your_turn', { kind: 'review' });
    expect(runBlockAction(review)).toMatchObject({
      kind: 'next',
      label: 'Open',
      behaviour: { kind: 'show_artifacts' },
    });
    expect(runBlockMarksDone(review)).toBe(false);
    expect(runBlockAction(runs.finalPage)).toEqual({ kind: 'resume', label: 'I paid' });
    expect(runBlockMarksDone(runs.finalPage)).toBe(false);
  });

  test('a run that is not handed off never marks done', () => {
    for (const run of [
      runs.running,
      runs.done,
      runs.failed,
      runs.cancelled,
      runs.needsAnswer,
      runs.stoppedTime,
    ])
      expect(runBlockMarksDone(run)).toBe(false);
  });
});

describe('the thread state ranks a run at work above another question', () => {
  const input = (over: Partial<ThreadStateInput>): ThreadStateInput => ({
    workState: 'active',
    planReady: true,
    totalSteps: 2,
    currentIndex: 0,
    activeRun: null,
    handoff: null,
    pendingQuestion: false,
    ...over,
  });

  test('a run at work outranks a question from another part of the Work', () => {
    expect(threadState(input({ activeRun: runs.running, pendingQuestion: true }))).toBe('running');
    expect(
      threadState(input({ activeRun: runs.running, pendingQuestion: true, handoff: runs.readyDraft })),
    ).toBe('running');
  });

  test('the current step question still comes first', () => {
    expect(
      threadState(input({ activeRun: runs.running, pendingQuestion: true, handoff: runs.needsAnswer })),
    ).toBe('needs_answer');
  });

  test('with no run at work, a pending question still asks', () => {
    expect(threadState(input({ pendingQuestion: true }))).toBe('needs_answer');
    expect(threadState(input({ pendingQuestion: true, handoff: runs.readyDraft }))).toBe('needs_answer');
    expect(threadState(input({ handoff: runs.readyDraft }))).toBe('waiting');
  });
});

// Questions the plan asked: the header counts them, so the thread shows them.
describe('openWorkQuestions', () => {
  test('keeps pending questions that no run owns', async () => {
    const { openWorkQuestions } = await import('../lib/albatross/thread-view');
    const questions = [
      { _id: 'q_plan', status: 'pending', prompt: 'Which weeks does the invoice cover?' },
      { _id: 'q_run', status: 'pending', prompt: 'Which class?' },
      { _id: 'q_done', status: 'answered', prompt: 'Which rate?' },
    ];
    const runs = [{ question: { id: 'q_run' } }, { question: null }] as unknown as ThreadRunView[];
    expect(openWorkQuestions({ questions }, runs).map((question) => question._id)).toEqual(['q_plan']);
    expect(openWorkQuestions(null, runs)).toEqual([]);
  });
});

// An answered contact field and a value of no special kind, as one line each.
describe('formValueDisplay for a contact and a plain value', () => {
  test('a contact names the person, the relation, and the phone', async () => {
    const { formValueDisplay } = await import('../lib/albatross/thread-view');
    const { phoneDisplay } = await import('../lib/personal-details/format');
    const phone = phoneDisplay('5555550100');
    const contact = { id: 'contact', label: 'Emergency contact', kind: 'contact' } as any;
    expect(
      formValueDisplay(contact, { name: 'Robin Lee', phone: '5555550100', relationship: 'Friend' } as any),
    ).toBe(`Robin Lee (Friend), ${phone}`);
    expect(formValueDisplay(contact, { name: 'Robin Lee', phone: '5555550100' } as any)).toBe(
      `Robin Lee, ${phone}`,
    );
    const hours = { id: 'hours', label: 'Hours', kind: 'number' } as any;
    expect(formValueDisplay(hours, 32 as any)).toBe('32');
  });
});
