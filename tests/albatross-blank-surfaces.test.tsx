import { describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { renderToStaticMarkup } from 'react-dom/server';
import { BlankSentence, blankMinWidth } from '../components/albatross/BlankSentence';
import { YourPartBar, YourPartCard } from '../components/albatross/thread/DocumentPane';
import { RunBlock } from '../components/albatross/thread/RunBlock';
import {
  DOCUMENTS_WAITING_COPY,
  DocumentsWaitingList,
  openWaitingDocument,
} from '../components/files/DocumentsWaiting';
import { documentHandoffRunsFixture, HOURS_DOCUMENT_ID } from '../lib/albatross/document-handoff-fixtures';
import { documentsWaitingRows, type StepRunHandoffItem } from '../lib/albatross/step-run-client';
import { handoffFixtures } from '../lib/albatross/step-run-fixtures';
import { threadDetailsFixture } from '../lib/albatross/thread-fixtures';
import { listCountSentence } from '../lib/albatross/thread-list-view';
import { useClientStore } from '../lib/client-state';

const NOW = Date.UTC(2026, 9, 9, 17, 15, 0);
const HOURS_BLANKS = ['hours for each week', 'hourly rate', 'invoice number'];
const noop = () => undefined;
const doc = (html: string) => new JSDOM(html).window.document;
const blanksIn = (html: string) =>
  [...doc(html).querySelectorAll('[data-blank]')].map((node) => node.getAttribute('data-blank'));

describe('BlankSentence', () => {
  test('draws one line for each blank, with the plain sentence for screen readers', () => {
    const html = renderToStaticMarkup(<BlankSentence blanks={HOURS_BLANKS} />);
    expect(blanksIn(html)).toEqual(HOURS_BLANKS);
    expect(doc(html).querySelector('.sr-only')?.textContent).toBe(
      'Fill in hours for each week, hourly rate, and invoice number.',
    );
    // Only the blanks use the highlight voice.
    expect(html).toContain('border-[var(--color-accent-3)]');
    expect(doc(html).querySelector('p')?.className).toContain('font-display');
  });

  test('without blanks it shows the fallback, and without either it shows nothing', () => {
    expect(
      doc(renderToStaticMarkup(<BlankSentence blanks={[]} fallback="Read the draft." />)).body.textContent,
    ).toBe('Read the draft.');
    expect(renderToStaticMarkup(<BlankSentence blanks={[]} fallback="  " />)).toBe('');
  });
});

describe('the run handoff', () => {
  const runs = documentHandoffRunsFixture(NOW);
  const details = threadDetailsFixture(NOW).details;
  const render = (run = runs.document) =>
    renderToStaticMarkup(
      <RunBlock
        run={run}
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
      />,
    );

  test('draws the blanks as the largest text, with the detail under them', () => {
    const html = render();
    const handoff = doc(html).querySelector('[data-slot="run-handoff"]');
    expect(blanksIn(handoff?.outerHTML ?? '')).toEqual(HOURS_BLANKS);
    expect(handoff?.querySelector('[data-blank-sentence]')?.className).toContain('text-[24px]');
    expect(handoff?.textContent).toContain('Then the next step drafts the email');
  });

  test('a handoff without blanks shows its detail in the display style, once', () => {
    const run = { ...runs.document, next: runs.document.next ? { ...runs.document.next, blanks: [] } : null };
    const handoff = doc(render(run)).querySelector('[data-slot="run-handoff"]');
    expect(handoff?.querySelector('[data-blank]')).toBeNull();
    expect(handoff?.querySelector('[data-blank-sentence]')?.textContent).toContain(
      'Fill in the hours for each week',
    );
    expect(handoff?.querySelectorAll('p').length).toBe(1);
  });
});

describe('document mode', () => {
  test('the card shows the blanks and no "Your part" label', () => {
    const html = renderToStaticMarkup(
      <YourPartCard
        stepLabel="Step 2: Make the hours summary and invoice"
        detail="Fill in the hours. Then the next step drafts the email."
        blanks={HOURS_BLANKS}
        busy={false}
        error={null}
        onDone={noop}
        onBack={noop}
      />,
    );
    expect(blanksIn(html)).toEqual(HOURS_BLANKS);
    expect(doc(html).body.textContent).not.toContain('Your part');
    expect(doc(html).body.textContent).toContain('Done, continue');
  });

  test('the narrow bar shows the blanks, or the detail when there are none', () => {
    const bar = (blanks: string[]) =>
      renderToStaticMarkup(
        <YourPartBar
          detail="Read the summary."
          blanks={blanks}
          busy={false}
          error={null}
          onDone={noop}
          onChat={noop}
        />,
      );
    expect(blanksIn(bar(HOURS_BLANKS))).toEqual(HOURS_BLANKS);
    expect(doc(bar([])).body.textContent).toContain('Read the summary.');
    expect(doc(bar([])).body.textContent).not.toContain('Your part');
  });
});

describe('the list count sentence', () => {
  test('counts what waits for you and what Albatross works on', () => {
    expect(listCountSentence(0, 0)).toBe('Nothing waits for you.');
    expect(listCountSentence(1, 0)).toBe('1 waits for you.');
    expect(listCountSentence(3, 2)).toBe('3 wait for you. Albatross works on 2.');
    expect(listCountSentence(0, 1)).toBe('Nothing waits for you. Albatross works on 1.');
  });
});

describe('Documents: waiting for you', () => {
  const hours: StepRunHandoffItem = {
    workId: 'work_hours',
    workTitle: 'Send the September hours and invoice to Harbor Design',
    run: documentHandoffRunsFixture(NOW).document,
  };

  test('keeps only open handoffs that open a document, with the document title and the blanks', () => {
    const rows = documentsWaitingRows([...handoffFixtures(NOW), hours]);
    expect(rows.every((row) => row.row.action?.behaviour.kind === 'open_document')).toBe(true);
    const row = rows.find((item) => item.workId === 'work_hours');
    expect(row?.blanks).toEqual(HOURS_BLANKS);
    expect(row?.documentTitle).toBe('September hours and invoice');
    expect(row?.row.action?.label).toBe('Fill in hours');
    expect(rows.some((item) => item.workId === 'work_claim')).toBe(false);
  });

  test('the section names the Albatross, draws the blanks, and hides when nothing waits', () => {
    const rows = documentsWaitingRows([hours]);
    const html = renderToStaticMarkup(<DocumentsWaitingList rows={rows} onOpen={noop} onOpenWork={noop} />);
    const text = doc(html).body.textContent ?? '';
    expect(text).toContain(DOCUMENTS_WAITING_COPY.heading);
    expect(text).toContain(DOCUMENTS_WAITING_COPY.madeFor(hours.workTitle));
    expect(blanksIn(html)).toEqual(HOURS_BLANKS);
    expect([...doc(html).querySelectorAll('button')].map((node) => node.textContent)).toEqual([
      'Fill in hours',
      'Open the Albatross',
    ]);
    expect(renderToStaticMarkup(<DocumentsWaitingList rows={[]} onOpen={noop} onOpenWork={noop} />)).toBe('');
  });

  test('the button opens the Albatross in document mode on that document', () => {
    const [row] = documentsWaitingRows([hours]);
    if (!row) throw new Error('no row');
    openWaitingDocument(row);
    const state = useClientStore.getState();
    expect(state.primaryView).toBe('albatrosses');
    expect(state.selectedWorkId).toBe('work_hours');
    expect(state.pendingThreadDocument).toEqual({
      workId: 'work_hours',
      target: { provider: 'albatross', id: HOURS_DOCUMENT_ID },
    });
    state.setPendingThreadDocument(null);
    expect(useClientStore.getState().pendingThreadDocument).toBeNull();
  });
});

describe('blank width', () => {
  test('a short name keeps the least width, a long name widens the line', () => {
    expect(blankMinWidth('rate')).toBe('max(5.4em, 37px)');
    expect(blankMinWidth('hours for each week')).toBe('max(5.4em, 130px)');
  });
});

describe('review fixes', () => {
  test('blanks alone fill the card and the bar, with no empty detail line', () => {
    const card = renderToStaticMarkup(
      <YourPartCard
        stepLabel={null}
        detail=""
        blanks={HOURS_BLANKS}
        busy={false}
        error={null}
        onDone={noop}
        onBack={noop}
      />,
    );
    expect(blanksIn(card)).toEqual(HOURS_BLANKS);
    expect(doc(card).querySelectorAll('section > p').length).toBe(1);
    const bar = renderToStaticMarkup(
      <YourPartBar
        detail={null}
        blanks={HOURS_BLANKS}
        busy={false}
        error={null}
        onDone={noop}
        onChat={noop}
      />,
    );
    expect(blanksIn(bar)).toEqual(HOURS_BLANKS);
  });

  test('a document row with no target clears an older open request', () => {
    const [row] = documentsWaitingRows([
      {
        workId: 'work_hours',
        workTitle: 'Send the September hours and invoice to Harbor Design',
        run: documentHandoffRunsFixture(NOW).document,
      },
    ]);
    if (!row) throw new Error('no row');
    useClientStore.getState().setPendingThreadDocument({
      workId: 'work_other',
      target: { provider: 'albatross', id: 'doc_other' },
    });
    openWaitingDocument({ ...row, row: { ...row.row, action: null } });
    expect(useClientStore.getState().pendingThreadDocument).toBeNull();
    expect(useClientStore.getState().selectedWorkId).toBe('work_hours');
  });
});
