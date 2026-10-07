import { describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { renderToStaticMarkup } from 'react-dom/server';
import { GuidedStepPane } from '../components/albatross/GuidedStep';
import { StepRunPanel, type StepRunPanelProps } from '../components/albatross/StepRunPanel';
import { ReadyForYouList, readyForYouCountLine } from '../components/report/ReadyForYou';
import { SAVED_SIGN_INS_COPY, SavedSignInsRow, savedSignInsHint } from '../components/settings/SavedSignIns';
import { COPY } from '../lib/albatross/step-run-client';
import { handoffFixtures, questionFixture, stepRunFixtures } from '../lib/albatross/step-run-fixtures';

const NOW = Date.UTC(2026, 9, 7, 14, 0, 0);
const runs = stepRunFixtures(NOW);
const noop = () => undefined;

function panel(over: Partial<StepRunPanelProps>) {
  return renderToStaticMarkup(
    <StepRunPanel
      run={null}
      stepDone={false}
      enabled
      runnable
      timeZone="UTC"
      onStart={noop}
      onCancel={noop}
      onResume={noop}
      onDismiss={noop}
      onDiscuss={noop}
      onNext={noop}
      onAnswer={noop}
      {...over}
    />,
  );
}

/** The action buttons (the shadcn Button). The log trigger and artifact rows are plain buttons. */
function buttons(html: string): string[] {
  const doc = new JSDOM(html).window.document;
  return [...doc.querySelectorAll('button[data-slot="button"]')].map(
    (node) => node.textContent?.trim() ?? '',
  );
}

function allButtons(html: string): string[] {
  const doc = new JSDOM(html).window.document;
  return [...doc.querySelectorAll('button')].map((node) => node.textContent?.trim() ?? '');
}

describe('StepRunPanel', () => {
  test('an eligible step offers "Handle it"; the feature off hides everything', () => {
    const html = panel({});
    expect(html).toContain('data-step-run="eligible"');
    expect(html).toContain(COPY.canHandle);
    expect(buttons(html)).toEqual(['Handle it']);
    expect(panel({ enabled: false })).toBe('');
    expect(panel({ runnable: false })).toBe('');
    expect(panel({ stepDone: true })).toBe('');
  });

  test('another step with the open run shows why there is no button', () => {
    const html = panel({ activeRun: runs.running });
    expect(html).toContain('data-step-run="blocked"');
    expect(html).toContain(COPY.blocked);
    expect(buttons(html)).toEqual([]);
  });

  test('a run at work shows its newest line, the log, and Stop', () => {
    const html = panel({ run: runs.running, activeRun: runs.running });
    expect(html).toContain('data-step-run="working"');
    expect(html).toContain('Filled the policy number and the claim reference');
    expect(html).toContain('Read the claim letter from 12 September');
    expect(html).toContain(COPY.soFar);
    expect(buttons(html)).toContain('Stop');
    expect(buttons(html)).not.toContain('Handle it');
    expect(html).toContain('data-state="open"');
  });

  test('a queued run says it waits', () => {
    const html = panel({ run: runs.queued, activeRun: runs.queued });
    expect(html).toContain(COPY.queued);
  });

  test('a draft handoff shows the headline, the summary, the files, and one primary button', () => {
    const html = panel({ run: runs.readyDraft });
    expect(html).toContain('data-outcome="ready_for_you"');
    expect(html).toContain(COPY.readyForYou);
    expect(html).toContain('I wrote the dispute letter');
    expect(html).toContain('Dispute of claim 44-2031');
    expect(html).toContain('Dispute letter.docx');
    expect(allButtons(html)).toEqual(
      expect.arrayContaining(['Dispute of claim 44-2031Draft', COPY.whatIDid]),
    );
    expect(html).toContain(COPY.whatIDid);
    expect(html).toContain('Read the draft. Send it when it is correct.');
    const labels = buttons(html);
    expect(labels).toEqual(expect.arrayContaining(['Read and send', 'Dismiss', 'Discuss this']));
    expect(labels).not.toContain('Continue');
    expect(labels).not.toContain('Handle it');
    // No icon before any button text.
    const doc = new JSDOM(html).window.document;
    for (const button of doc.querySelectorAll('button[data-slot="button"]')) {
      expect(button.firstElementChild?.tagName).not.toBe('svg');
    }
  });

  test('a sign-in handoff adds Continue after the primary button', () => {
    const html = panel({ run: runs.signIn });
    expect(buttons(html)).toEqual(['Sign in', 'Continue', 'Dismiss', 'Discuss this']);
    expect(html).toContain(COPY.yourTurn);
  });

  test('a question handoff has no primary button; it shows the choices', () => {
    const html = panel({ run: runs.needsAnswer, question: questionFixture });
    expect(html).toContain(COPY.needsAnswer);
    expect(html).toContain('Which office takes the packet?');
    expect(html).toContain('Downtown office');
    expect(allButtons(html).join('|')).toContain('Downtown office');
    expect(allButtons(html).join('|')).toContain('North county office');
    expect(buttons(html)).toEqual(['Answer', 'Dismiss', 'Discuss this']);
  });

  test('a run stopped at its limit says which limit and offers Continue', () => {
    const time = panel({ run: runs.stoppedTime });
    expect(time).toContain(COPY.stoppedTime);
    expect(buttons(time)).toEqual(['Continue', 'Dismiss', 'Discuss this']);
    const cost = panel({ run: runs.stoppedCost });
    expect(cost).toContain(COPY.stoppedCost);
    expect(buttons(cost)).toEqual(['Continue', 'Dismiss', 'Discuss this']);
  });

  test('an offline handoff ends in the usual step check', () => {
    expect(buttons(panel({ run: runs.offline }))).toEqual(['Mark this step done', 'Dismiss', 'Discuss this']);
  });

  test('a failed run shows the reason and "Try again"', () => {
    const html = panel({ run: runs.failed });
    expect(html).toContain('data-step-run="failed"');
    expect(html).toContain(COPY.failed);
    expect(html).toContain('The insurer site did not load after three tries.');
    expect(buttons(html)).toEqual(['Try again', 'Discuss this']);
  });

  test('a done run renders nothing on an undone step row and nothing on a done one', () => {
    expect(panel({ run: runs.done, stepDone: true })).toBe('');
    expect(buttons(panel({ run: runs.done }))).toEqual(['Handle it']);
  });

  test('every fixture renders', () => {
    for (const run of Object.values(runs)) expect(() => panel({ run })).not.toThrow();
  });
});

describe('the guided pane with a run', () => {
  const steps = [
    { id: 'one', title: 'First', knows: [], needsYou: [], done: false, runLabel: 'Albatross is on it' },
    { id: 'two', title: 'Second', knows: [], needsYou: [], done: false },
  ];
  const session = {
    sessionId: 's',
    status: 'agent',
    statusDetail: 'Opening the form',
    liveViewUrl: 'about:blank',
  };

  test('shows the ledger label, the run panel, the agent line, and Take over', () => {
    const html = renderToStaticMarkup(
      <GuidedStepPane
        steps={steps}
        activeId="one"
        onComplete={noop}
        onVerifySession={noop}
        session={session}
        runPanel={<div data-run-panel>panel</div>}
        browser={{ line: 'Opening the form', action: 'take_over', onTakeOver: noop }}
      />,
    );
    expect(html).toContain('data-slot="ledger-run-label"');
    expect(html).toContain('Albatross is on it');
    expect(html).toContain('data-run-panel');
    expect(html).toContain('Opening the form');
    expect(buttons(html)).toContain('Take over');
    // The user's own check waits while the agent has the page.
    const doc = new JSDOM(html).window.document;
    const check = [...doc.querySelectorAll('button')].find((node) => node.textContent === 'Check the page');
    expect(check?.hasAttribute('disabled')).toBe(true);
  });

  test('after a sign-in handoff the bar offers Continue', () => {
    const html = renderToStaticMarkup(
      <GuidedStepPane
        steps={steps}
        activeId="one"
        onComplete={noop}
        session={{ ...session, status: 'user' }}
        browser={{ line: 'Sign in, then press Continue.', action: 'continue', onContinue: noop }}
      />,
    );
    expect(html).toContain('Sign in, then press Continue.');
    expect(buttons(html)).toContain('Continue');
    expect(buttons(html)).not.toContain('Take over');
  });
});

describe('the Brief list', () => {
  test('one row per Work, one button per handoff, none for a run at work', () => {
    const html = renderToStaticMarkup(
      <ReadyForYouList items={handoffFixtures(NOW)} onOpenWork={noop} onAct={noop} />,
    );
    expect(html).toContain('Ready for you');
    // The run at work is not a step that waits for the user.
    expect(html).toContain('3 steps wait for you.');
    expect(html).toContain('Working on: Send the dispute letter to the insurer');
    expect(html).toContain('Renew the office lease');
    expect(buttons(html)).toEqual(['Open the document', 'Sign in', 'Continue']);
    expect(allButtons(html)).toEqual(
      expect.arrayContaining(['Dispute the water damage claim', 'Move the deposit to the new account']),
    );
  });

  test('the count line names waiting steps, then steps at work', () => {
    const working = handoffFixtures(NOW).slice(0, 1);
    const html = renderToStaticMarkup(<ReadyForYouList items={working} onOpenWork={noop} onAct={noop} />);
    expect(html).toContain('Albatross works on one step.');
    expect(readyForYouCountLine([])).toBe('Albatross works on 0 steps.');
  });

  test('hides when empty', () => {
    expect(renderToStaticMarkup(<ReadyForYouList items={[]} onOpenWork={noop} onAct={noop} />)).toBe('');
    expect(
      renderToStaticMarkup(
        <ReadyForYouList
          items={[{ workId: 'a', workTitle: 'A', run: runs.done }]}
          onOpenWork={noop}
          onAct={noop}
        />,
      ),
    ).toBe('');
  });
});

describe('Saved sign-ins', () => {
  test('the hint says whether a context exists and when it was used', () => {
    expect(savedSignInsHint(null)).toBe(SAVED_SIGN_INS_COPY.none);
    expect(savedSignInsHint({ saved: false })).toBe(SAVED_SIGN_INS_COPY.none);
    expect(savedSignInsHint({ saved: true }, NOW)).toBe('Saved.');
    expect(savedSignInsHint({ saved: true, lastUsedAt: NOW - 3_600_000 }, NOW)).toBe(
      'Saved. Last used today.',
    );
    expect(savedSignInsHint({ saved: true, lastUsedAt: NOW - 86_400_000 }, NOW)).toBe(
      'Saved. Last used yesterday.',
    );
    expect(savedSignInsHint({ saved: true, createdAt: NOW - 5 * 86_400_000 }, NOW)).toBe(
      'Saved. Last used 5 days ago.',
    );
  });

  test('the row says Albatross never sees a password and offers Forget only when saved', () => {
    const saved = renderToStaticMarkup(
      <SavedSignInsRow state={{ saved: true, lastUsedAt: NOW }} onForget={noop} />,
    );
    expect(saved).toContain('Albatross never sees a password.');
    expect(buttons(saved)).toEqual([SAVED_SIGN_INS_COPY.forget]);
    const none = renderToStaticMarkup(<SavedSignInsRow state={{ saved: false }} onForget={noop} />);
    expect(none).toContain(SAVED_SIGN_INS_COPY.none);
    expect(buttons(none)).toEqual([]);
  });
});
