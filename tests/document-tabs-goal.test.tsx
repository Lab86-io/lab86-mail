import { describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { renderToStaticMarkup } from 'react-dom/server';
import { ItemPartCard } from '../components/albatross/thread/DocumentPane';
import { DocumentTabs, tabHopKey } from '../components/albatross/thread/DocumentTabs';
import { documentHandoffFor } from '../lib/albatross/document-handoff';
import { packageTabs } from '../lib/albatross/goal-run-view';
import {
  GOAL_DRAFT_ID,
  GOAL_INVOICE_DOCUMENT_ID,
  goalItemsFixture,
  goalRunFixtures,
} from '../lib/albatross/thread-fixtures';

/* Document mode with a package (docs/research/goal-runs-web-design-2026-10-15.md,
 * §5): the tab bar, the still-yours dot with its name, the sent mark, the
 * bracket keys, and the "Your part" card of an item. */

const NOW = Date.UTC(2026, 9, 15, 18, 44, 0);
const runs = goalRunFixtures(NOW);
const tabs = packageTabs(runs.goalPackage);
const noop = () => undefined;

describe('the tab bar', () => {
  test('one tab per item, the active one selected, the still-yours dot named', () => {
    const html = renderToStaticMarkup(
      <DocumentTabs
        tabs={tabs}
        activeKey={`document:${GOAL_INVOICE_DOCUMENT_ID}`}
        onSelect={noop}
        onClose={noop}
      />,
    );
    const doc = new JSDOM(html).window.document;
    const items = [...doc.querySelectorAll('[role="tab"]')];
    expect(items.length).toBe(4);
    expect(items.map((tab) => tab.getAttribute('aria-selected'))).toEqual([
      'false',
      'true',
      'false',
      'false',
    ]);
    expect(items.map((tab) => tab.getAttribute('tabindex'))).toEqual(['-1', '0', '-1', '-1']);
    const dots = [...doc.querySelectorAll('[data-slot="tab-still-yours"]')];
    expect(dots.length).toBe(3);
    expect(dots[0].getAttribute('aria-label')).toBe('Still yours');
    expect(dots[0].getAttribute('title')).toBe('Still yours');
    expect(items[2].querySelector('[data-slot="tab-still-yours"]')).toBeNull();
    expect(doc.body.textContent).toContain('Close');
  });

  test('a sent draft reads Sent instead of the dot', () => {
    const html = renderToStaticMarkup(
      <DocumentTabs
        tabs={tabs}
        activeKey={tabs[0].key}
        sent={{ [GOAL_DRAFT_ID]: '3:02 PM' }}
        onSelect={noop}
        onClose={noop}
      />,
    );
    const doc = new JSDOM(html).window.document;
    const first = doc.querySelector('[role="tab"]')!;
    expect(first.textContent).toContain('Sent');
    expect(first.querySelector('[data-slot="tab-still-yours"]')).toBeNull();
  });

  test('the bracket keys move between tabs and wrap', () => {
    const keys = tabs.map((tab) => tab.key);
    const press = (key: string, code: string) => ({
      key,
      code,
      metaKey: true,
      altKey: true,
      ctrlKey: false,
      shiftKey: false,
    });
    expect(tabHopKey(press(']', 'BracketRight'), keys, keys[0])).toBe(keys[1]);
    expect(tabHopKey(press('[', 'BracketLeft'), keys, keys[0])).toBe(keys[3]);
    expect(tabHopKey(press(']', 'BracketRight'), keys, keys[3])).toBe(keys[0]);
    expect(tabHopKey({ ...press(']', 'BracketRight'), altKey: false }, keys, keys[0])).toBeNull();
    expect(tabHopKey(press('x', 'KeyX'), keys, keys[0])).toBeNull();
    expect(tabHopKey(press(']', 'BracketRight'), [keys[0]], keys[0])).toBeNull();
  });
});

describe('the Your part card of an item', () => {
  test('the title, the blank sentence, the note, and the two buttons', () => {
    const item = goalItemsFixture()[1];
    const html = renderToStaticMarkup(
      <ItemPartCard item={item} busy={false} error={null} onDone={noop} onBack={noop} />,
    );
    const doc = new JSDOM(html).window.document;
    expect(doc.body.textContent).toContain('Invoice 0007');
    expect(doc.body.textContent).not.toContain('Invoice 0007 · Document');
    expect(doc.querySelector('[data-blank-sentence]')?.textContent).toContain('Fill in');
    expect(doc.body.textContent).toContain('From the invoice template, 78 hours in July.');
    const buttons = [...doc.querySelectorAll('button')].map((button) => button.textContent);
    expect(buttons).toEqual(['Done, continue', 'Back to thread']);
  });

  test('filled blanks read as done', () => {
    const item = goalItemsFixture()[1];
    const html = renderToStaticMarkup(
      <ItemPartCard item={item} blanksFilled busy={false} error={null} onDone={noop} onBack={noop} />,
    );
    const doc = new JSDOM(html).window.document;
    expect(doc.querySelector('[data-blank-sentence]')).toBeNull();
    expect(doc.body.textContent).toContain('All blanks are filled in.');
  });
});

describe('the handoff of a document', () => {
  test('a package item finds its run', () => {
    const run = documentHandoffFor([runs.goalRunning, runs.goalPackage], {
      provider: 'albatross',
      id: GOAL_INVOICE_DOCUMENT_ID,
    });
    expect(run?.id).toBe('run_goal_package');
    expect(documentHandoffFor([runs.goalPackage], { provider: 'albatross', id: 'doc_other' })).toBeNull();
  });
});
