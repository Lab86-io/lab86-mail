import { describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReadyForYouList, readyForYouCountLine } from '../components/report/ReadyForYou';
import { SAVED_SIGN_INS_COPY, SavedSignInsRow, savedSignInsHint } from '../components/settings/SavedSignIns';
import { handoffFixtures, stepRunFixtures } from '../lib/albatross/step-run-fixtures';

const NOW = Date.UTC(2026, 9, 7, 14, 0, 0);
const runs = stepRunFixtures(NOW);
const noop = () => undefined;

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

describe('the Brief list', () => {
  test('one row per Work, one button per handoff, none for a run at work', () => {
    const html = renderToStaticMarkup(
      <ReadyForYouList items={handoffFixtures(NOW)} onOpenWork={noop} onAct={noop} />,
    );
    expect(html).toContain('Ready for you');
    // The run at work is not a step that waits for the user.
    expect(html).toContain('3 steps wait for you.');
    expect(html).toContain('In progress: Send the dispute letter to the insurer');
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
