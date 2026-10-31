import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import {
  THREAD_OBLIGATION_COPY,
  ThreadObligations,
  type ThreadObligationsProps,
} from '../components/albatross/thread/ThreadObligations';
import type { ObligationAction, ObligationView } from '../lib/obligations/contract';
import {
  NEEDS_YOU_FIXTURE_NOW,
  NEEDS_YOU_FIXTURE_TIMEZONE,
  needsYouFixture,
  workObligationsFixture,
} from '../lib/obligations/fixtures';

/* Needs you items inside a Work thread (docs/needs-you.md, screen 5; phase 3 W4). */

const NOW = NEEDS_YOU_FIXTURE_NOW;
const TZ = NEEDS_YOU_FIXTURE_TIMEZONE;
const items = workObligationsFixture(NOW, TZ);
const byId = (id: string) => needsYouFixture(NOW, TZ).items.find((item) => item.id === id) as ObligationView;
const doc = (html: string) => new JSDOM(html).window.document;

function props(overrides: Partial<ThreadObligationsProps> = {}) {
  const actions: { id: string; action: ObligationAction }[] = [];
  const handled: string[] = [];
  const value: ThreadObligationsProps = {
    items,
    now: NOW,
    timeZone: TZ,
    busyId: null,
    error: null,
    onAction: (obligation, action) => {
      actions.push({ id: obligation.id, action });
    },
    onHandle: (obligation) => {
      handled.push(obligation.id);
    },
    ...overrides,
  };
  return { value, actions, handled };
}

const globals = globalThis as unknown as Record<string, unknown>;
const saved: Record<string, unknown> = {};
function useBrowserGlobals() {
  beforeAll(() => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    for (const name of ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'])
      saved[name] = globals[name];
    globals.window = dom.window;
    globals.document = dom.window.document;
    globals.navigator = dom.window.navigator;
    globals.IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    for (const name of ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT']) {
      if (saved[name] === undefined) delete globals[name];
      else globals[name] = saved[name];
    }
  });
}

const mount = async (value: ThreadObligationsProps) => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<ThreadObligations {...value} />);
  });
  return renderer;
};
const buttonIn = (renderer: ReactTestRenderer, id: string, label: string) =>
  renderer.root
    .findAll((node) => node.type === 'article' && node.props['data-thread-obligation'] === id)[0]
    .findAll((node) => node.type === 'button' && node.props.children === label)[0];

describe('the cards', () => {
  const html = renderToStaticMarkup(<ThreadObligations {...props().value} />);
  const page = doc(html);

  test('the items come in time order, the oldest first, closed ones included', () => {
    const ids = [...page.querySelectorAll('[data-thread-obligation]')].map((node) =>
      node.getAttribute('data-thread-obligation'),
    );
    expect(ids).toEqual(['ob_numbers', 'ob_prepare', 'ob_slack_numbers']);
    expect(page.querySelector('section')?.getAttribute('aria-label')).toBe('Needs you');
  });

  test('an open card: the kicker, the source, the time, the sentence, the evidence, the quote, the actions', () => {
    const card = page.querySelector('[data-thread-obligation="ob_slack_numbers"]');
    const text = card?.textContent ?? '';
    expect(card?.className).toContain('surface-accent');
    expect(text).toContain(THREAD_OBLIGATION_COPY.kicker);
    expect(text).toContain('Slack · #release');
    expect(text).toContain('10:02 AM');
    expect(text).toContain('Asks for the Q3 numbers before the Friday review.');
    expect(text).toContain('Priya named you and asked for the numbers.');
    const quote = card?.querySelector('[data-thread-obligation-quote]');
    expect(quote?.textContent).toContain('Priya Raman');
    expect(quote?.textContent).toContain('@alex can you drop the Q3 numbers');
    const buttons = [...(card?.querySelectorAll('button[data-variant]') ?? [])].map(
      (node) => node.textContent,
    );
    expect(buttons).toEqual(['Handle it', 'Done', 'Later', 'Not mine']);
    const link = card?.querySelector('[data-needs-you-open-in="slack"]');
    expect(link?.textContent).toBe('Open in Slack');
    expect(link?.getAttribute('target')).toBe('_blank');
    for (const button of card?.querySelectorAll('button') ?? []) {
      expect(button.firstElementChild?.tagName).not.toBe('svg');
    }
  });

  test('a closed card is quiet and says why it closed', () => {
    const card = page.querySelector('[data-thread-obligation="ob_numbers"]');
    expect(card?.getAttribute('data-obligation-state')).toBe('done');
    expect(card?.className).not.toContain('surface-accent');
    expect(card?.textContent).toContain('Done, no reply sent');
    expect(card?.textContent).toContain('10:12 AM');
    expect(card?.querySelectorAll('button')).toHaveLength(0);
  });

  test('a calendar item gets the event glyph, and an invitation answers Yes, No, or Maybe', () => {
    const prepare = page.querySelector('[data-thread-obligation="ob_prepare"]');
    expect(prepare?.querySelector('[data-needs-you-glyph="calendar"]')).not.toBeNull();
    const rsvp = renderToStaticMarkup(<ThreadObligations {...props({ items: [byId('ob_rsvp')] }).value} />);
    const buttons = [...doc(rsvp).querySelectorAll('button[data-variant]')].map((node) => node.textContent);
    expect(buttons).toEqual(['Yes', 'No', 'Maybe', 'Later', 'Not mine']);
  });

  test('nothing renders without items, and a snoozed item stays out', () => {
    expect(renderToStaticMarkup(<ThreadObligations {...props({ items: [] }).value} />)).toBe('');
    const snoozed = { ...byId('ob_slack_numbers'), state: 'snoozed' as const, snoozedUntil: NOW + 3_600_000 };
    expect(renderToStaticMarkup(<ThreadObligations {...props({ items: [snoozed] }).value} />)).toBe('');
  });

  test('a busy card disables its buttons; a failed action shows its line on that card alone', () => {
    const busy = doc(
      renderToStaticMarkup(<ThreadObligations {...props({ busyId: 'ob_slack_numbers' }).value} />),
    );
    const slack = busy.querySelector('[data-thread-obligation="ob_slack_numbers"]');
    expect(slack?.querySelector('button[data-variant]')?.hasAttribute('disabled')).toBe(true);
    const prepare = busy.querySelector('[data-thread-obligation="ob_prepare"]');
    expect(prepare?.querySelector('button[data-variant]')?.hasAttribute('disabled')).toBe(false);
    const failed = doc(
      renderToStaticMarkup(
        <ThreadObligations {...props({ error: { id: 'ob_prepare', text: 'The server said no.' } }).value} />,
      ),
    );
    expect(failed.querySelector('[data-thread-obligation="ob_prepare"] [role="alert"]')?.textContent).toBe(
      'The server said no.',
    );
    expect(failed.querySelector('[data-thread-obligation="ob_slack_numbers"] [role="alert"]')).toBeNull();
  });
});

describe('the actions', () => {
  useBrowserGlobals();

  test('Handle it, Done, Not mine, and an answer reach the thread with the item', async () => {
    const h = props();
    const renderer = await mount(h.value);
    await act(async () => buttonIn(renderer, 'ob_slack_numbers', 'Handle it').props.onClick());
    expect(h.handled).toEqual(['ob_slack_numbers']);
    await act(async () => buttonIn(renderer, 'ob_prepare', 'Done').props.onClick());
    await act(async () => buttonIn(renderer, 'ob_slack_numbers', 'Not mine').props.onClick());
    expect(h.actions).toEqual([
      { id: 'ob_prepare', action: { action: 'done' } },
      { id: 'ob_slack_numbers', action: { action: 'not_mine' } },
    ]);
    const rsvp = props({ items: [byId('ob_rsvp')] });
    const invitation = await mount(rsvp.value);
    await act(async () => buttonIn(invitation, 'ob_rsvp', 'No').props.onClick());
    expect(rsvp.actions).toEqual([{ id: 'ob_rsvp', action: { action: 'rsvp', response: 'no' } }]);
  });

  test('Later offers the page times and snoozes until the chosen one', async () => {
    const h = props();
    const renderer = await mount(h.value);
    // The menu content renders in a portal, so the test calls the card's handler with its options.
    const card = renderer.root.find(
      (node) =>
        node.props.obligation?.id === 'ob_slack_numbers' &&
        Array.isArray(node.props.laterOptions) &&
        typeof node.props.onAction === 'function',
    );
    const options = card.props.laterOptions as { label: string; until: number }[];
    expect(options.map((option) => option.label)).toEqual(['Later today', 'Tomorrow morning', 'Next week']);
    await act(async () => card.props.onAction({ action: 'later', until: options[1].until }));
    expect(h.actions).toEqual([
      { id: 'ob_slack_numbers', action: { action: 'later', until: options[1].until } },
    ]);
  });
});
