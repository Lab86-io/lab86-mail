import { describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { renderToStaticMarkup } from 'react-dom/server';
import { RunBlock } from '../components/albatross/thread/RunBlock';
import type { ThreadRunView } from '../lib/albatross/thread-contract';
import { goalRunFixtures, threadRunFixtures } from '../lib/albatross/thread-fixtures';

/* The run block of a goal run (docs/research/goal-runs-web-design-2026-10-15.md,
 * §3): messages with source chips, the checklist with its state words, the
 * package rows, "Not sure", and the buttons of each state. A step run keeps
 * its block. */

const NOW = Date.UTC(2026, 9, 15, 18, 44, 0);
const noop = () => undefined;

function render(run: ThreadRunView, over: Partial<Parameters<typeof RunBlock>[0]> = {}) {
  const html = renderToStaticMarkup(
    <RunBlock
      run={run}
      timeZone="UTC"
      onStop={noop}
      onResume={noop}
      onDismiss={noop}
      onStart={noop}
      onMarkDone={noop}
      onNext={noop}
      onAnswer={noop}
      onOpenPackage={noop}
      onOpenItem={noop}
      onDoneContinue={noop}
      onOpenSource={noop}
      {...over}
    />,
  );
  return new JSDOM(html).window.document;
}

const texts = (doc: Document, selector: string) =>
  [...doc.querySelectorAll(selector)].map((node) => node.textContent?.trim() ?? '');
const buttons = (doc: Document) => texts(doc, 'button');

describe('a goal run in progress', () => {
  const runs = goalRunFixtures(NOW);
  const doc = render(runs.goalRunning);

  test('the header is the start time and the state, no step', () => {
    const block = doc.querySelector('[data-slot="run-block"]')!;
    expect(block.getAttribute('data-run-goal')).toBe('true');
    expect(block.querySelector('header')?.textContent).toContain('Started 6:38 PM');
    expect(block.querySelector('header')?.textContent).not.toContain('Step');
    expect(block.querySelector('[data-slot="run-state"]')?.textContent).toBe('In progress');
  });

  test('the newest six messages are open, the earlier one folds, and their sources are chips', () => {
    expect(doc.querySelectorAll('[data-slot="run-message"]').length).toBe(6);
    expect(doc.querySelector('[data-slot="earlier-messages"]')?.textContent).toContain('Earlier messages');
    expect(doc.querySelector('[data-slot="earlier-messages"]')?.textContent).toContain('1');
    const chips = texts(doc, '[data-slot="source"]');
    expect(chips).toContain('BP-214 worklog, JulyBP-214');
    expect(chips).toContain('July hours');
    const packageDoc = render(runs.goalPackage);
    expect(texts(packageDoc, '[data-slot="source"]')).toContain('Form W-9 (Rev. March 2024)irs.gov');
    const web = packageDoc.querySelector('a[data-slot="source"]')!;
    expect(web.getAttribute('target')).toBe('_blank');
    expect(web.getAttribute('rel')).toContain('noopener');
    expect(web.getAttribute('aria-label')).toContain('opens in a new tab');
  });

  test('no chip text joins its parts with a middle dot', () => {
    for (const chip of texts(doc, '[data-slot="source"]')) expect(chip).not.toContain('·');
  });

  test('the checklist is open with state words, no check marks, and the doing row carries the live dot', () => {
    const list = doc.querySelector('[data-slot="checklist"]')!;
    expect(list.getAttribute('aria-label')).toBe('Checklist, 2 of 7 done');
    const rows = [...list.querySelectorAll('li')];
    expect(rows.length).toBe(7);
    expect(rows[0].textContent).toContain('Done');
    expect(rows[2].querySelector('[data-slot="reveal-dot"]')).not.toBeNull();
    expect(rows[6].textContent).toContain('Yours');
    expect(list.textContent).not.toContain('✓');
    expect(doc.querySelector('[data-slot="checklist-trigger"]')?.textContent).toContain('2 of 7');
  });

  test('the current item shows once: no live line while the open checklist names it', () => {
    expect(doc.querySelector('[data-slot="run-live-line"]')).toBeNull();
    expect(doc.querySelector('[data-slot="run-block"]')?.textContent).toContain(
      'Make the invoice from the template',
    );
  });

  test('the log folds, and Stop is the one button', () => {
    expect(doc.body.textContent).toContain('What Albatross did');
    expect(buttons(doc)).toContain('Stop');
    expect(buttons(doc)).not.toContain('Mark step done');
  });

  test('a queued run says it starts soon, or when a run ends past the cap', () => {
    expect(render(runs.goalQueued).querySelector('[data-slot="run-live-line"]')?.textContent).toBe(
      'Starts soon',
    );
    expect(render(runs.goalQueued, { pastCap: true }).body.textContent).toContain('Starts when a run ends');
  });
});

describe('a goal run handed off with a package', () => {
  const runs = goalRunFixtures(NOW);
  const doc = render(runs.goalPackage);

  test('the header gives the start time and the duration, with no dot between them', () => {
    const header = doc.querySelector('header')!;
    expect(header.textContent).toContain('6:31 PM');
    expect(header.textContent).toContain('11 min');
    expect(header.querySelector('span')?.textContent).not.toContain('·');
  });

  test('three messages stay open and the summary does not repeat them', () => {
    expect(doc.querySelectorAll('[data-slot="run-message"]').length).toBe(3);
    expect(doc.body.textContent).not.toContain(runs.goalPackage.summary!);
  });

  test('the blank sentence, the package rows, and Not sure', () => {
    expect(doc.querySelector('[data-blank-sentence]')?.textContent).toContain('Fill in');
    const rows = [...doc.querySelectorAll('[data-slot="package-rows"] li')];
    expect(rows.length).toBe(4);
    expect(rows.map((row) => row.querySelector('button') !== null)).toEqual([true, true, true, true]);
    expect(rows[0].textContent).toContain('Invoice 0007 to Priya Natarajan');
    expect(rows[0].textContent).toContain('Draft');
    expect(rows[0].textContent).toContain('Check it.');
    expect(rows[1].textContent).toContain('Fill in rate.');
    expect(rows[2].textContent).toContain('Ready.');
    expect(rows[3].textContent).toContain('The tax ID fills in when you send.');
    const unsure = doc.querySelector('[data-slot="not-sure"]')!;
    expect(unsure.querySelector('h3')?.textContent).toBe('Not sure');
    expect(unsure.querySelectorAll('p').length).toBe(2);
  });

  test('the checklist folds after the run ends', () => {
    expect(doc.querySelector('[data-slot="checklist-trigger"]')?.textContent).toContain('6 of 7');
    expect(doc.querySelector('[data-slot="checklist"]')).toBeNull();
  });

  test('the buttons are Open the package, Done, continue, and Dismiss', () => {
    const labels = buttons(doc);
    expect(labels).toContain('Open the package');
    expect(labels).toContain('Done, continue');
    expect(labels).toContain('Dismiss');
    expect(labels).not.toContain('Mark step done');
    expect(labels).not.toContain('Mark it done');
  });

  test('a sent draft reads Sent on its row', () => {
    const sent = render(runs.goalPackage, { sentDrafts: { draft_invoice_0007: '3:02 PM' } });
    expect(sent.querySelector('[data-slot="package-rows"] li')?.textContent).toContain('Sent 3:02 PM.');
  });

  test('document mode keeps only the record of the handoff', () => {
    const elsewhere = render(runs.goalPackage, { handoffShownElsewhere: true });
    expect(buttons(elsewhere)).not.toContain('Open the package');
    expect(elsewhere.querySelector('[data-blank-sentence]')).toBeNull();
  });
});

describe('the other goal run states', () => {
  const runs = goalRunFixtures(NOW);

  test('a question shows the form after the messages, with no main button', () => {
    const doc = render(runs.goalNeedsAnswer);
    expect(doc.body.textContent).toContain('Which address for Priya?');
    expect(buttons(doc)).not.toContain('Open the package');
    expect(doc.querySelector('[data-slot="run-state"]')?.textContent).toContain('Needs your answer');
  });

  test('a stopped run says the next run starts from the checklist and offers Continue', () => {
    const doc = render(runs.goalStoppedTime);
    expect(doc.body.textContent).toContain(
      'Albatross stopped at its time limit. The next run starts from the checklist.',
    );
    expect(buttons(doc)).toContain('Continue');
    expect(buttons(doc)).not.toContain('Handle it');
    expect(doc.querySelector('[data-slot="checklist"]')?.getAttribute('aria-label')).toBe(
      'Checklist, 4 of 7 done',
    );
  });

  test('a failed run says why and offers Try again', () => {
    const doc = render(runs.goalFailed, { startable: true });
    expect(doc.body.textContent).toContain('This run did not finish.');
    expect(doc.body.textContent).toContain('Jira did not answer after three tries.');
    expect(buttons(doc)).toContain('Try again');
  });

  test('a done run keeps its message and its mail source', () => {
    const doc = render(runs.goalDone);
    expect(doc.querySelector('[data-slot="run-state"]')?.textContent).toContain('Done');
    expect(texts(doc, '[data-slot="source"]')).toContain('Invoice 0007 for July');
    // Only the folds are buttons: no action is left.
    for (const label of ['Stop', 'Continue', 'Dismiss', 'Done, continue', 'Open the package', 'Try again'])
      expect(buttons(doc)).not.toContain(label);
  });

  test('a closed package keeps its rows and no buttons', () => {
    const doc = render(runs.goalClosedPackage);
    expect(doc.querySelector('[data-slot="run-state"]')?.textContent).toContain('Closed');
    expect(doc.querySelectorAll('[data-slot="package-rows"] li').length).toBe(4);
    expect(buttons(doc).filter((label) => label !== 'Earlier messages 8')).not.toContain('Done, continue');
  });

  test('a page handoff keeps its done label', () => {
    const doc = render(runs.goalYourTurn, { onOpenPage: noop });
    expect(buttons(doc)).toContain('I signed in');
    expect(buttons(doc)).not.toContain('Done, continue');
  });
});

describe('a step run is unchanged', () => {
  const steps = threadRunFixtures(NOW);

  test('the header names the step, the log opens while it works, and Mark step done stays', () => {
    const running = render(steps.running, { stepNumber: 1 });
    expect(running.querySelector('header')?.textContent).toContain('Step 1');
    expect(running.querySelector('[data-slot="run-block"]')?.getAttribute('data-run-goal')).toBeNull();
    expect(running.querySelector('[data-slot="run-live-line"]')).not.toBeNull();
    const ready = render(steps.readyDraft, { stepNumber: 2 });
    expect(buttons(ready)).toContain('Read and send');
    expect(buttons(ready)).toContain('Mark step done');
    expect(ready.querySelector('[data-slot="run-messages"]')).toBeNull();
    expect(ready.querySelector('[data-slot="package-rows"]')).toBeNull();
  });
});
