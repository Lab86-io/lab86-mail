import { describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { renderToStaticMarkup } from 'react-dom/server';
import { FormQuestionCard } from '../components/ai-elements/form-question-card';
import { DetailsPanel } from '../components/albatross/thread/DetailsPanel';
import { PAGE_PANE_COPY, PagePane, pagePaneView } from '../components/albatross/thread/PagePane';
import { PlanIntro, PlanLine } from '../components/albatross/thread/PlanIntro';
import { RunBlock, type RunBlockProps } from '../components/albatross/thread/RunBlock';
import { PersonalDetailsList } from '../components/settings/PersonalDetailsSection';
import {
  classQuestionForm,
  threadDetailDoneStep,
  threadDetailFixture,
  threadDetailsFixture,
  threadDetailsWithPhone,
  threadRunFixtures,
  threadSessionFixture,
} from '../lib/albatross/thread-fixtures';
import { planStepRows } from '../lib/albatross/thread-view';

const NOW = Date.UTC(2026, 9, 7, 14, 46, 0);
const runs = threadRunFixtures(NOW);
const details = threadDetailsFixture(NOW).details;
const noop = () => undefined;

function block(over: Partial<RunBlockProps>) {
  return renderToStaticMarkup(
    <RunBlock
      run={runs.running}
      timeZone="UTC"
      details={details}
      onStop={noop}
      onResume={noop}
      onDismiss={noop}
      onStart={noop}
      onMarkDone={noop}
      onNext={noop}
      onAnswer={noop}
      onOpenPage={noop}
      {...over}
    />,
  );
}

/** The action buttons (the shadcn Button). Log triggers and option rows are plain buttons. */
function buttons(html: string): string[] {
  const doc = new JSDOM(html).window.document;
  return [...doc.querySelectorAll('button[data-slot="button"]')].map(
    (node) => node.textContent?.trim() ?? '',
  );
}

function noIconBeforeText(html: string) {
  const doc = new JSDOM(html).window.document;
  for (const button of doc.querySelectorAll('button[data-slot="button"]')) {
    expect(button.firstElementChild?.tagName).not.toBe('svg');
  }
}

describe('the run block', () => {
  test('a run at work: step, state word, the newest line, the open log, and Stop', () => {
    const html = block({ run: runs.running, stepNumber: 1 });
    expect(html).toContain('data-run-state="running"');
    expect(html).toContain('Step 1');
    expect(html).toContain('In progress');
    expect(html).toContain('Checked your calendar for each class');
    expect(html).toContain('What Albatross did');
    expect(html).toContain('data-state="open"');
    expect(buttons(html)).toEqual(['Stop']);
    noIconBeforeText(html);
  });

  test('a steered run shows that it read the note', () => {
    expect(block({ run: runs.steered })).toContain('Read your note: use the Monday class');
  });

  test('a question renders the form with the recommended class selected, the saved details, and the open phone field', () => {
    const html = block({ run: runs.needsAnswer });
    expect(html).toContain('Needs your answer');
    expect(html).toContain('data-thread-pending-form');
    expect(html).toContain('Which class?');
    expect(html).toContain('Matches what you said');
    expect(html).toContain('Free on your calendar');
    expect(html).toContain('Conflicts with Team sync, 5:00 PM');
    const doc = new JSDOM(html).window.document;
    const selected = [...doc.querySelectorAll('[data-option-state="selected"]')];
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toContain('Monday, October 19');
    expect(html).toContain('Sam Rivera');
    expect(html).toContain('From your details');
    expect(html).toContain('sam.rivera@example.com');
    expect(html).toContain('From your account');
    expect(html).toContain('12 Elm Street, Apt 3, Springfield, IL 62704');
    expect(html).toContain('The site sends the Zoom invite by text message.');
    expect(html).toContain('Change');
    // The runner question has one primary button and the block's quiet Dismiss. No Skip (decision 3).
    expect(buttons(html)).toEqual(['Continue', 'Dismiss']);
    expect(html).not.toContain('>Skip<');
  });

  test('an answered question collapses to its receipt, with the saved detail and Undo', () => {
    const html = block({ run: runs.answeredForm, onUndoSave: async () => undefined });
    expect(html).toContain('data-slot="form-receipt"');
    expect(html).toContain('Answered');
    expect(html).toContain('Monday, October 19');
    expect(html).toContain('(555) 555-0100');
    expect(html).toContain('Saved to your details: Phone');
    expect(html).toContain('Undo');
    expect(buttons(html)).toEqual([]);
    expect(html).not.toContain('data-thread-pending-form');
  });

  test('a question the chat answered says so', () => {
    const html = block({ run: runs.answeredChat });
    expect(html).toContain('Answered in the chat.');
    expect(html).toContain('(555) 555-0100');
  });

  test("the user's turn on the final page: headline, detail, the done label, Dismiss", () => {
    const html = block({ run: runs.finalPage, continues: true });
    expect(html).toContain('data-slot="run-continued"');
    expect(html).toContain('Continued');
    expect(html).toContain('Your turn');
    expect(html).toContain('Everything is filled in. Check it and pay the $70.');
    expect(buttons(html)).toEqual(
      ['Open the page', 'I paid', 'Dismiss'].filter((label) => label !== 'Open the page'),
    );
    expect(html).toContain('Open the page');
    expect(block({ run: runs.finalPage, pageOpen: true })).not.toContain('Open the page');
    expect(html).not.toContain('Check the page');
  });

  test('a sign-in handoff uses its done label', () => {
    expect(buttons(block({ run: runs.signIn }))).toEqual(['I signed in', 'Dismiss']);
  });

  test('a draft handoff lists the file and offers Read and send', () => {
    const html = block({ run: runs.readyDraft });
    expect(html).toContain('Ready for you');
    expect(html).toContain('Alive at 25 completion certificate');
    expect(buttons(html)).toEqual(['Read and send', 'Dismiss']);
  });

  test('a done run shows the state and the summary, and no buttons', () => {
    const html = block({ run: runs.done });
    expect(html).toContain('Done');
    expect(html).toContain('Order A1234');
    expect(buttons(html)).toEqual([]);
  });

  test('a failed run says why and offers Try again only when the step may start again', () => {
    const html = block({ run: runs.failed, startable: true });
    expect(html).toContain('Did not finish');
    expect(html).toContain('This run did not finish.');
    expect(html).toContain('The site did not load after three tries.');
    expect(buttons(html)).toEqual(['Try again']);
    expect(buttons(block({ run: runs.failed }))).toEqual([]);
  });

  test('a run stopped at its limit names the limit and offers Continue', () => {
    const html = block({ run: runs.stoppedTime });
    expect(html).toContain('Stopped');
    expect(html).toContain('Albatross stopped at its time limit.');
    expect(buttons(html)).toEqual(['Continue', 'Dismiss']);
  });

  test('a cancelled run says "Stopped by you" and offers Handle it when it may', () => {
    const html = block({ run: runs.cancelled, startable: true });
    expect(html).toContain('Stopped by you');
    expect(buttons(html)).toEqual(['Handle it']);
  });

  test('every fixture renders', () => {
    for (const run of Object.values(runs)) expect(() => block({ run })).not.toThrow();
  });
});

describe('the form card in the chat', () => {
  test('offers Skip and the submit label, with the save box for a new bound value', () => {
    const form = {
      ...classQuestionForm,
      fields: [
        classQuestionForm.fields[0],
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
    const html = renderToStaticMarkup(
      <FormQuestionCard form={form} mode="chat" details={details} onSubmit={noop} onSkip={noop} />,
    );
    expect(html).toContain('data-form-mode="chat"');
    expect(html).toContain('From your email signature');
    expect(html).toContain('Save phone to my details');
    expect(buttons(html)).toEqual(['Skip', 'Continue']);
  });

  test('a skipped question shows as skipped', () => {
    const html = renderToStaticMarkup(
      <FormQuestionCard
        form={classQuestionForm}
        mode="chat"
        receipt={{ values: null, stateLine: 'Skipped' }}
        onSubmit={noop}
      />,
    );
    expect(html).toContain('Skipped');
    expect(html).not.toContain('Save');
  });

  test('a custom submit label replaces Continue', () => {
    const html = renderToStaticMarkup(
      <FormQuestionCard
        form={{ ...classQuestionForm, submitLabel: 'Register' }}
        mode="runner"
        onSubmit={noop}
      />,
    );
    expect(buttons(html)).toEqual(['Register']);
  });
});

describe('the page pane', () => {
  test('says who has the page and offers the one control that fits', () => {
    expect(
      pagePaneView(threadSessionFixture('agent', 'Reading the class schedule'), runs.running),
    ).toMatchObject({
      dot: 'agent',
      lead: PAGE_PANE_COPY.agentLead,
      detail: 'Reading the class schedule',
      action: { kind: 'take_over' },
      closes: false,
    });
    expect(pagePaneView(threadSessionFixture('user'), runs.needsAnswer)).toMatchObject({
      dot: 'paused',
      lead: 'Paused.',
      detail: 'Albatross continues after your answer.',
      action: null,
      closes: true,
    });
    expect(pagePaneView(threadSessionFixture('user'), runs.finalPage)).toMatchObject({
      dot: 'user',
      lead: 'Your turn.',
      detail: 'Everything is filled in. Check it and pay the $70.',
      action: { kind: 'done', label: 'I paid' },
      closes: true,
    });
    expect(pagePaneView(threadSessionFixture('verifying'), runs.finalPage)).toMatchObject({
      dot: 'checking',
      action: null,
    });
    expect(pagePaneView(threadSessionFixture('starting'), null)).toMatchObject({ dot: 'opening' });
    expect(pagePaneView(null, null)).toMatchObject({ dot: 'closed', action: { kind: 'reopen' } });
    expect(pagePaneView(threadSessionFixture('failed'), null)).toMatchObject({
      dot: 'error',
      action: { kind: 'retry' },
    });
  });

  test('renders the live view, the address, and never "Check the page"', () => {
    const html = renderToStaticMarkup(
      <PagePane
        session={threadSessionFixture('user')}
        run={runs.finalPage}
        url="https://aliveat25.example.com/classes"
        onTakeOver={noop}
        onDone={noop}
        onClose={noop}
      />,
    );
    expect(html).toContain('<iframe');
    expect(html).toContain('aliveat25.example.com/classes');
    expect(html).toContain('aria-label="Page: aliveat25.example.com"');
    expect(buttons(html)).toEqual(['I paid', 'Close the page']);
    expect(html).not.toContain('Check the page');
    const agent = renderToStaticMarkup(
      <PagePane
        session={threadSessionFixture('agent')}
        run={runs.running}
        onTakeOver={noop}
        onDone={noop}
        onClose={noop}
      />,
    );
    expect(buttons(agent)).toEqual(['Take over']);
  });
});

describe('the plan block and the plan line', () => {
  const detail = threadDetailFixture(NOW);

  test('the plan block names the outcome, the steps, and Handle it on the current step', () => {
    const html = renderToStaticMarkup(
      <PlanIntro
        outcome={detail.plan!.outcome!}
        summary={detail.plan!.summary}
        steps={planStepRows(detail.execution.guideSteps, { runnerEnabled: true })}
        state="ready"
        onHandle={noop}
      />,
    );
    expect(html).toContain('What Albatross understood');
    expect(html).toContain('Register for and complete the Alive at 25 course');
    expect(html).toContain('Register for the course');
    expect(html).toContain('Attend the court appearance on November 2');
    expect(html).toContain('Yours, offline');
    expect(buttons(html)).toEqual(['Handle it']);
    noIconBeforeText(html);
  });

  test('a done step shows its proof; a step in progress shows no button', () => {
    const html = renderToStaticMarkup(
      <PlanIntro
        outcome="Outcome"
        steps={planStepRows(threadDetailDoneStep(NOW).execution.guideSteps, { runnerEnabled: true })}
        state="ready"
        activeStepKey="step-2"
        onHandle={noop}
      />,
    );
    expect(html).toContain('Verified on the page · Registration confirmed, order A1234');
    expect(buttons(html)).toEqual([]);
  });

  test('while the plan is not ready the block says so', () => {
    const html = renderToStaticMarkup(<PlanIntro outcome="Outcome" steps={[]} state="planning" />);
    expect(html).toContain('Albatross makes the plan.');
  });

  test('the plan line splits the step and the state', () => {
    const html = renderToStaticMarkup(<PlanLine text="Step 1 of 2 · Your turn" state="waiting" />);
    expect(html).toContain('Step 1 of 2');
    expect(html).toContain('Your turn');
    expect(html).toContain('aria-label="Plan, step 1 of 2 · your turn"');
  });
});

describe('the details panel', () => {
  test('carries the plan, the files with Undo, the sources, and no plan document when there is none', () => {
    const detail = threadDetailFixture(NOW);
    const html = renderToStaticMarkup(
      <DetailsPanel
        detail={detail}
        steps={planStepRows(detail.execution.guideSteps, { runnerEnabled: true })}
        onHandle={noop}
        undoneOperations={new Set()}
        undoing={null}
        onUndo={noop}
        onError={noop}
        onClose={noop}
      />,
    );
    expect(html).toContain('Plan');
    expect(html).toContain('Files');
    expect(html).toContain('Court appearance, November 2');
    expect(html).toContain('Sources and assumptions');
    expect(buttons(html)).toEqual(expect.arrayContaining(['Close', 'Handle it', 'Undo']));
    expect(html).not.toContain('Read the plan');
  });
});

describe('the personal details settings', () => {
  test('lists each detail with its source, the missing ones with Add, and the legal-name hint', () => {
    const html = renderToStaticMarkup(
      <PersonalDetailsList
        response={threadDetailsWithPhone(NOW)}
        accountName="Sam rivera"
        onSave={async () => true}
        onDelete={noop}
        timeZone="UTC"
      />,
    );
    expect(html).toContain('Personal details');
    expect(html).toContain('It never keeps passwords, card numbers, or ID numbers here.');
    expect(html).toContain('3 saved');
    expect(html).toContain('Sam Rivera');
    expect(html).toContain('You changed this on Oct 4');
    expect(html).toContain('Account name: Sam rivera');
    expect(html).toContain('From your account');
    expect(html).toContain('(555) 555-0100');
    expect(html).toContain('You told Albatross on Oct 7');
    expect(html).toContain('Not saved');
    const labels = buttons(html);
    expect(labels.filter((label) => label === 'Change')).toHaveLength(4);
    expect(labels.filter((label) => label === 'Delete')).toHaveLength(3);
    expect(labels).toContain('Add');
    expect(labels).toContain('Add a detail');
  });

  test('a save error shows under its row', () => {
    const html = renderToStaticMarkup(
      <PersonalDetailsList
        response={threadDetailsFixture(NOW)}
        error={{ key: 'phone', message: 'Albatross does not keep this number here.' }}
        onSave={async () => true}
        onDelete={noop}
      />,
    );
    expect(html).toContain('Albatross does not keep this number here.');
  });
});
