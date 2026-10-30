import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { arrivalSentence, NeedsYouToast, newArrivals } from '../components/needs-you/NeedsYouArrivals';
import { rowWords } from '../components/needs-you/NeedsYouRow';
import { mailThreadOf } from '../components/needs-you/NeedsYouSurface';
import {
  NEEDS_YOU_ROW_CAP,
  type NeedsYouNotifier,
  NeedsYouView,
  type NeedsYouViewProps,
} from '../components/needs-you/NeedsYouView';
import { needsYouExtras } from '../components/needs-you/useNeedsYou';
import type { NotificationItem } from '../components/notifications/model';
import { bellWords } from '../components/shell/NotificationCenter';
import { SHORTCUTS } from '../components/shell/ShortcutsSheet';
import type { ObligationAction, ObligationView } from '../lib/obligations/contract';
import { UNDO_WINDOW_MS } from '../lib/obligations/contract';
import {
  NEEDS_YOU_FIXTURE_NOW,
  NEEDS_YOU_FIXTURE_TIMEZONE,
  needsYouFixture,
} from '../lib/obligations/fixtures';
import type { NeedsYouEntry } from '../lib/obligations/groups';

/* The Needs you page (docs/needs-you-phase-1.md, W2 and W3). */

const NOW = NEEDS_YOU_FIXTURE_NOW;
const TZ = NEEDS_YOU_FIXTURE_TIMEZONE;
const fixture = needsYouFixture(NOW, TZ);
const extras = fixture.extras as unknown as NotificationItem[];
const doc = (html: string) => new JSDOM(html).window.document;
const byId = (id: string) => fixture.items.find((item) => item.id === id) as ObligationView;

interface Harness {
  props: NeedsYouViewProps;
  actions: { id: string; action: ObligationAction }[];
  replies: { id: string; body: string }[];
  toasts: { kind: string; title: string; description?: string; until?: number }[];
  undo: (() => Promise<void>) | null;
  copied: string[];
}

function harness(overrides: Partial<NeedsYouViewProps> = {}): Harness {
  const actions: Harness['actions'] = [];
  const replies: Harness['replies'] = [];
  const toasts: Harness['toasts'] = [];
  const copied: string[] = [];
  const state: Harness = { actions, replies, toasts, undo: null, copied, props: {} as NeedsYouViewProps };
  const notify: NeedsYouNotifier = {
    undo: ({ title, description, until, onUndo }) => {
      toasts.push({ kind: 'undo', title, description, until });
      state.undo = onUndo;
    },
    info: (title, description) => toasts.push({ kind: 'info', title, description }),
    error: (title) => toasts.push({ kind: 'error', title }),
  };
  state.props = {
    items: fixture.items,
    extras,
    timezone: TZ,
    now: NOW,
    notify,
    copyText: async (text) => {
      copied.push(text);
    },
    onObligationAction: async (obligation, action) => {
      actions.push({ id: obligation.id, action });
      const at = NOW + 60_000;
      const next: ObligationView =
        action.action === 'undo'
          ? { ...byId(obligation.id), updatedAt: at }
          : action.action === 'later'
            ? { ...obligation, state: 'snoozed', snoozedUntil: action.until, updatedAt: at }
            : {
                ...obligation,
                state: action.action === 'not_mine' ? 'dismissed' : 'done',
                closedAt: at,
                closeReason:
                  action.action === 'not_mine'
                    ? 'not_mine'
                    : obligation.kind === 'reply'
                      ? 'user_done_no_reply'
                      : 'user_done',
                updatedAt: at,
              };
      return {
        obligation: next,
        undoUntil: action.action === 'undo' ? undefined : Date.now() + UNDO_WINDOW_MS,
      };
    },
    onLoadDraft: async (obligation) => {
      const draft = fixture.drafts[obligation.id];
      if (!draft) throw new Error('No draft.');
      return { draft };
    },
    onSendReply: async (obligation, body) => {
      replies.push({ id: obligation.id, body });
      const at = NOW + 60_000;
      return {
        obligation: { ...obligation, state: 'done', closedAt: at, closeReason: 'sent_reply', updatedAt: at },
        undoUntil: Date.now() + UNDO_WINDOW_MS,
      };
    },
    onOpenSource: () => {},
    onAlbatrossAction: () => {},
    onOpenActivity: () => {},
    ...overrides,
  };
  return state;
}

/* The interactive tests mount with react-test-renderer. The Later menu (Radix)
 * listens on `document`, so a window stands in for the browser while they run. */
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

const mount = async (props: NeedsYouViewProps) => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<NeedsYouView {...props} />);
  });
  return renderer;
};
const rowButton = (renderer: ReactTestRenderer, id: string) =>
  renderer.root
    .findAll((node) => node.type === 'li' && node.props['data-needs-you-row'] === id)[0]
    .findAllByType('button')[0];
const buttonNamed = (renderer: ReactTestRenderer, label: string): ReactTestInstance =>
  renderer.root
    .findByProps({ 'aria-label': 'Details' })
    .findAll(
      (node) =>
        node.type === 'button' &&
        (node.props.children === label ||
          (Array.isArray(node.props.children) && node.props.children[0] === label)),
    )[0];
interface KeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target: unknown;
  prevented?: boolean;
  preventDefault(): void;
}
const key = (value: string, extra: Partial<KeyEvent> = {}): KeyEvent => {
  const event: KeyEvent = {
    key: value,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    target: null,
    ...extra,
    preventDefault() {
      event.prevented = true;
    },
  };
  return event;
};

describe('the list', () => {
  const html = renderToStaticMarkup(<NeedsYouView {...harness().props} />);
  const page = doc(html);

  test('shows the groups in order with their counts, and the summary line', () => {
    const heads = [...page.querySelectorAll('h2')].map((node) => node.textContent);
    expect(heads).toEqual([
      'Now3',
      'Today2',
      'This week2',
      'After this week1',
      'No due date1',
      'Waiting on others1',
      'Closed today4',
    ]);
    expect(page.querySelector('header p')?.textContent).toBe('3 now · 10 open · 4 closed today');
    expect(html).toContain('Activity history');
  });

  test('the code is the row, in large tabular type, and the closed group starts collapsed', () => {
    const code = page.querySelector('[data-needs-you-code]');
    expect(code?.textContent).toBe('482 913');
    expect(code?.className).toContain('text-[22px]');
    expect(html).toContain('Verification code');
    expect(html).toContain('8 min<small');
    expect(page.querySelector('[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false');
    expect(page.querySelectorAll('[data-needs-you-row]')).toHaveLength(10);
  });

  test('each row names the asker, the source, the line, the time, and the due day', () => {
    const rows = [...page.querySelectorAll('[data-needs-you-row]')].map((node) => node.textContent);
    expect(rows[1]).toContain('Harbor Air');
    expect(rows[1]).toContain('Flight HA 220 now departs');
    expect(rows[1]).toContain('9:12 AM · Time-sensitive change');
    expect(rows[1]).toContain('Today 6:40 PM');
    expect(rows[2]).toContain('Q3 review deck');
    expect(rows[2]).toContain('Albatross');
    expect(rows[2]).toContain('Your turn');
    expect(rows[5]).toContain('Dana Whitfield');
    expect(rows[5]).toContain('Yesterday 4:48 PM · Reply');
    expect(rows[5]).toContain('Fri');
    expect(rows[9]).toContain('Marco Ruiz');
    expect(rows[9]).toContain('6 dayswaiting');
    // Only one row is in the tab order.
    expect(page.querySelectorAll('[data-needs-you-row] > button[tabindex="0"]')).toHaveLength(1);
  });

  test('the empty detail invites a selection; with nothing open it says so', () => {
    expect(html).toContain('A little attention goes a long way.');
    const empty = renderToStaticMarkup(
      <NeedsYouView
        {...harness({ items: fixture.items.filter((item) => item.state !== 'open'), extras: [] }).props}
      />,
    );
    expect(empty).toContain('Nothing needs you right now.');
    expect(empty).toContain('You’re caught up.');
    expect(empty).toContain('Closed today');
  });

  test('while it loads, the summary says so and the skeleton shows', () => {
    const loading = renderToStaticMarkup(<NeedsYouView {...harness({ isLoading: true }).props} />);
    expect(loading).toContain('Finding what needs you');
    expect(loading).not.toContain('Northwind Bank');
  });

  test('a long group shows the cap and a "Show N more" line', () => {
    const many = Array.from({ length: NEEDS_YOU_ROW_CAP + 5 }, (_, index) => ({
      ...byId('ob_panel'),
      id: `ob_many_${index}`,
      createdAt: NOW - index * 1000,
      updatedAt: NOW - index * 1000,
    }));
    const page = doc(renderToStaticMarkup(<NeedsYouView {...harness({ items: many, extras: [] }).props} />));
    expect(page.querySelectorAll('[data-needs-you-row]')).toHaveLength(NEEDS_YOU_ROW_CAP);
    expect(page.body.textContent).toContain('Show 5 more');
  });

  test('row words for a closed code and for an Albatross item', () => {
    const closedCode: NeedsYouEntry<NotificationItem> = {
      type: 'obligation',
      id: 'c',
      obligation: byId('ob_code_used'),
    };
    expect(rowWords(closedCode, NOW, TZ)).toMatchObject({
      line: 'Verification code.',
      meta: '7:58 AM',
      due: { text: 'Code used', tone: 'done' },
    });
    const question: NeedsYouEntry<NotificationItem> = { type: 'albatross', id: 'q', item: extras[0] };
    expect(rowWords(question, NOW, TZ)).toMatchObject({ name: 'Q3 review deck', source: 'Albatross' });
    const checkin: NeedsYouEntry<NotificationItem> = {
      type: 'albatross',
      id: 'k',
      item: { ...extras[1], createdAt: undefined, context: 'Work · you put this down' },
    };
    expect(rowWords(checkin, NOW, TZ)).toMatchObject({
      name: 'Daily check-in',
      meta: 'Check-in',
      due: { text: 'Today' },
    });
  });
});

describe('the detail', () => {
  useBrowserGlobals();
  test('a reply opens with its draft, then Send reply sends the edited text and closes the row', async () => {
    const h = harness();
    const renderer = await mount(h.props);
    await act(async () => rowButton(renderer, 'ob_sow').props.onClick());
    const section = renderer.root.findByProps({ 'aria-label': 'Details' });
    const text = renderToStaticMarkup(section.props.children);
    expect(text).toContain('Dana Whitfield');
    expect(text).toContain('Why this needs you');
    expect(text).toContain('Due Friday');
    const field = renderer.root.findByType('textarea');
    expect(field.props.value).toContain('November 16 works on our side.');
    await act(async () => field.props.onChange({ target: { value: 'Confirmed for November 16.' } }));
    expect(renderToStaticMarkup(section.props.children)).toContain('Edited');
    await act(async () => buttonNamed(renderer, 'Send reply').props.onClick());
    expect(h.replies).toEqual([{ id: 'ob_sow', body: 'Confirmed for November 16.' }]);
    expect(h.toasts[0]).toMatchObject({ kind: 'undo', title: 'Replied' });
    const html = renderToStaticMarkup(<NeedsYouView {...h.props} />);
    expect(html).not.toContain('Draft ready');
  });

  test('Done closes at once with Undo; Undo brings the row back; a reply says no reply was sent', async () => {
    const h = harness();
    const renderer = await mount(h.props);
    await act(async () => rowButton(renderer, 'ob_sow').props.onClick());
    await act(async () => buttonNamed(renderer, 'Done').props.onClick());
    expect(h.actions).toEqual([{ id: 'ob_sow', action: { action: 'done' } }]);
    expect(h.toasts[0]).toMatchObject({ kind: 'undo', title: 'Done', description: 'No reply sent.' });
    // The row moved to Closed today with its reason, and the next row is open in the detail.
    const closedHead = renderer.root
      .findByProps({ 'data-needs-you-list': true })
      .findByProps({ 'aria-expanded': false });
    await act(async () => closedHead.props.onClick());
    const closedRow = renderer.root.findAll(
      (node) => node.type === 'li' && node.props['data-needs-you-row'] === 'ob_sow',
    )[0];
    expect(renderToStaticMarkup(closedRow.props.children)).toContain('Done, no reply sent');
    expect(renderer.root.findByProps({ 'aria-label': 'Details' }).props.className).not.toContain('hidden');
    await act(async () => h.undo?.());
    expect(h.actions[1]).toEqual({ id: 'ob_sow', action: { action: 'undo' } });
    const back = renderer.root.findAll(
      (node) => node.type === 'li' && node.props['data-needs-you-row'] === 'ob_sow',
    )[0];
    expect(renderToStaticMarkup(back.props.children)).toContain('Fri');
  });

  test('Later offers three times and snoozes until the chosen one', async () => {
    const h = harness();
    const renderer = await mount(h.props);
    await act(async () => rowButton(renderer, 'ob_nda').props.onClick());
    // The menu content renders in a portal, so the test calls the detail's Later handler.
    const detail = renderer.root.find(
      (node) => typeof node.props.onLater === 'function' && Array.isArray(node.props.laterOptions),
    );
    const options = detail.props.laterOptions as { id: string; until: number }[];
    expect(options).toHaveLength(3);
    expect(new Set(options.map((option) => option.until)).size).toBe(3);
    await act(async () => detail.props.onLater(options[1]));
    expect(h.actions[0]).toEqual({ id: 'ob_nda', action: { action: 'later', until: options[1].until } });
    expect(h.toasts[0]).toMatchObject({ title: 'Later' });
  });

  test('Not mine dismisses', async () => {
    const h = harness();
    const renderer = await mount(h.props);
    await act(async () => rowButton(renderer, 'ob_nda').props.onClick());
    await act(async () => buttonNamed(renderer, 'Not mine').props.onClick());
    expect(h.actions[0]).toEqual({ id: 'ob_nda', action: { action: 'not_mine' } });
    expect(h.toasts[0]).toMatchObject({ title: 'Not mine' });
  });

  test('a code shows large, copies to the clipboard, and says Copied', async () => {
    const h = harness();
    const renderer = await mount(h.props);
    await act(async () => rowButton(renderer, 'ob_code_now').props.onClick());
    const section = renderer.root.findByProps({ 'aria-label': 'Details' });
    const html = renderToStaticMarkup(section.props.children);
    expect(html).toContain('text-[44px]');
    expect(html).toContain('Expires in');
    expect(html).toContain('Pushed at once, in quiet hours too.');
    expect(html).not.toContain('>Later<');
    await act(async () => buttonNamed(renderer, 'Copy code').props.onClick());
    expect(h.copied).toEqual(['482913']);
    expect(buttonNamed(renderer, 'Copied')).toBeDefined();
  });

  test('an Albatross question keeps its own action', async () => {
    const opened: unknown[] = [];
    const h = harness({
      onAlbatrossAction: (action) => {
        opened.push(action);
      },
    });
    const renderer = await mount(h.props);
    await act(async () => rowButton(renderer, 'question:q_deck').props.onClick());
    const section = renderer.root.findByProps({ 'aria-label': 'Details' });
    const html = renderToStaticMarkup(section.props.children);
    expect(html).toContain('Which quarter numbers should the deck use?');
    expect(html).toContain('Opening this does not resolve it.');
    expect(html).not.toContain('Not mine');
    await act(async () => buttonNamed(renderer, 'Answer in Albatross').props.onClick());
    expect(opened).toEqual([{ kind: 'work', workId: 'work_q3_deck' }]);
  });

  test('a failed action shows its message and keeps the row', async () => {
    const h = harness({
      onObligationAction: async () => {
        throw new Error('The server said no.');
      },
    });
    const renderer = await mount(h.props);
    await act(async () => rowButton(renderer, 'ob_nda').props.onClick());
    await act(async () => buttonNamed(renderer, 'Done').props.onClick());
    const section = renderer.root.findByProps({ 'aria-label': 'Details' });
    expect(renderToStaticMarkup(section.props.children)).toContain('The server said no.');
    expect(h.toasts).toEqual([]);
  });

  test('an open request selects its item', async () => {
    const h = harness({ openRequest: { id: 'ob_flight', at: 1 } });
    const renderer = await mount(h.props);
    const section = renderer.root.findByProps({ 'aria-label': 'Details' });
    expect(renderToStaticMarkup(section.props.children)).toContain('Time-sensitive change');
  });
});

describe('the keys', () => {
  useBrowserGlobals();
  test('e marks the focused row done, l opens Later, Enter opens, Escape goes back', async () => {
    const h = harness();
    const renderer = await mount(h.props);
    const row = rowButton(renderer, 'ob_nda');
    const done = key('e');
    await act(async () => row.props.onKeyDown(done));
    expect(done.prevented).toBe(true);
    expect(h.actions[0]).toEqual({ id: 'ob_nda', action: { action: 'done' } });
    const later = key('l');
    await act(async () => rowButton(renderer, 'ob_sow').props.onKeyDown(later));
    expect(later.prevented).toBe(true);
    expect(renderer.root.findByProps({ 'aria-label': 'Details' }).props.className).not.toContain('hidden');
    const escapeKey = key('Escape');
    await act(async () => renderer.root.findByProps({ 'aria-label': 'Details' }).props.onKeyDown(escapeKey));
    expect(escapeKey.prevented).toBe(true);
    expect(renderer.root.findByProps({ 'aria-label': 'Details' }).props.className).toContain('hidden');
    const enter = key('Enter');
    await act(async () => rowButton(renderer, 'ob_flight').props.onKeyDown(enter));
    expect(enter.prevented).toBe(true);
    // A modifier leaves the key to the browser; a code has no Later.
    const cmd = key('e', { metaKey: true });
    await act(async () => rowButton(renderer, 'ob_flight').props.onKeyDown(cmd));
    expect(cmd.prevented).toBeUndefined();
    const codeLater = key('l');
    await act(async () => rowButton(renderer, 'ob_code_now').props.onKeyDown(codeLater));
    expect(codeLater.prevented).toBeUndefined();
  });

  test('Cmd+Enter in the detail runs the first action; letters do nothing inside the draft', async () => {
    const h = harness();
    const renderer = await mount(h.props);
    await act(async () => rowButton(renderer, 'ob_flight').props.onKeyDown(key('Enter')));
    const details = renderer.root.findByProps({ 'aria-label': 'Details' });
    await act(async () => details.props.onKeyDown(key('Enter', { metaKey: true })));
    expect(h.actions[0]).toEqual({ id: 'ob_flight', action: { action: 'done' } });
    await act(async () => rowButton(renderer, 'ob_sow').props.onKeyDown(key('Enter')));
    const typed = key('e', { target: { tagName: 'TEXTAREA' } });
    await act(async () => renderer.root.findByProps({ 'aria-label': 'Details' }).props.onKeyDown(typed));
    expect(typed.prevented).toBeUndefined();
    expect(h.actions).toHaveLength(1);
  });

  test('the keys are in the shortcuts sheet, and none collides with a global mail key', () => {
    const labels = SHORTCUTS.filter(([, label]) => label.startsWith('Needs you:'));
    expect(labels.map(([keys]) => keys.join('+'))).toEqual(['j+k', 'enter', 'e', 'l', '⌘/Ctrl+enter', 'esc']);
    // The page handles its keys on the focused row and the detail, and
    // prevents the default, so the global mail handler skips them.
    expect(SHORTCUTS.some(([keys, label]) => keys.includes('n') && !label.startsWith('Needs you:'))).toBe(
      true,
    );
    expect(labels.some(([keys]) => keys.includes('n'))).toBe(false);
  });
});

describe('the bell and the toast', () => {
  test('the bell counts the Now group for a flag user, and attention items for everyone else', () => {
    expect(bellWords(3, true)).toEqual({ title: 'Needs you · 3 now', label: 'Needs you, 3 now' });
    expect(bellWords(0, true)).toEqual({ title: 'Needs you', label: 'Needs you' });
    expect(bellWords(2, false)).toEqual({
      title: 'Notifications',
      label: 'Notifications, 2 items need attention',
    });
    expect(bellWords(0, false).label).toBe('Notifications');
  });

  test('only questions, approvals, and check-ins that need attention join the list', () => {
    const rows = [
      { ...extras[0], kind: 'update' as const },
      { ...extras[0], id: 'closed', attention: false },
      extras[1],
    ];
    expect(needsYouExtras(rows).map((row) => row.id)).toEqual(['checkin:today']);
  });

  test('a new Now item toasts once, an old item that only became overdue does not', () => {
    const fresh = byId('ob_code_now');
    const old = { ...byId('ob_flight'), createdAt: NOW - 60 * 60_000 };
    expect(newArrivals([fresh, old], new Set(), NOW).map((item) => item.id)).toEqual(['ob_code_now']);
    expect(newArrivals([fresh], new Set(['ob_code_now']), NOW)).toEqual([]);
  });

  test('the toast names the asker in the same breath as the ask, with Open and Later; a code shows Copy code', () => {
    expect(arrivalSentence(byId('ob_sow'))).toBe(
      'Dana Whitfield asks you to confirm the revised start date in the SOW by Friday.',
    );
    expect(arrivalSentence({ asker: 'Harbor Air', title: 'SOW moved.' })).toBe('Harbor Air SOW moved.');
    const noop = () => {};
    const reply = renderToStaticMarkup(
      <NeedsYouToast
        obligation={byId('ob_sow')}
        now={NOW}
        timezone={TZ}
        onOpen={noop}
        onLater={noop}
        onCopy={noop}
      />,
    );
    expect(reply).toContain('asks you to confirm the revised start date');
    expect(reply).toContain('Mail · Reply · Due Friday');
    expect(reply).toContain('>Open<');
    expect(reply).toContain('>Later<');
    const code = renderToStaticMarkup(
      <NeedsYouToast
        obligation={byId('ob_code_now')}
        now={NOW}
        timezone={TZ}
        onOpen={noop}
        onLater={noop}
        onCopy={noop}
      />,
    );
    expect(code).toContain('482 913');
    expect(code).toContain('Copy code');
    expect(code).not.toContain('>Later<');
  });

  test('the source thread comes from the fields, or from the source key', () => {
    expect(mailThreadOf(byId('ob_sow'))).toEqual({ accountId: 'acct_alex', threadId: 'thr_dana_sow' });
    expect(mailThreadOf({ sourceKey: 'mail:acct:thread:with:colons' })).toEqual({
      accountId: 'acct',
      threadId: 'thread:with:colons',
    });
    expect(mailThreadOf({ sourceKey: 'slack:x' })).toBeNull();
  });
});
