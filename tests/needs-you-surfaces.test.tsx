import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { JSDOM } from 'jsdom';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import {
  CALENDAR_NEEDS_YOU_COPY,
  CalendarNeedsYouItems,
  EventNeedsYou,
  EventNeedsYouMark,
} from '../components/needs-you/CalendarNeedsYou';
import { NeedsYouRow } from '../components/needs-you/NeedsYouRow';
import { THREAD_STRIP_COPY, ThreadNeedsYouStrip } from '../components/needs-you/ThreadNeedsYouStrip';
import { TodayNeedsYou, type TodayNeedsYouProps } from '../components/needs-you/TodayNeedsYou';
import type { NotificationItem } from '../components/notifications/model';
import { BriefCanvas } from '../components/report/brief-canvas/BriefCanvas';
import { BriefLiveLayer } from '../components/report/live-layer';
import { SHORTCUTS } from '../components/shell/ShortcutsSheet';
import { interleaveThreadExtras, type ThreadTimelineItem } from '../lib/albatross/thread-contract';
import { applyObligationsToThreadRows, THREAD_ROW_ITEM_WORD } from '../lib/albatross/thread-list-view';
import type { ThreadRow } from '../lib/albatross/threads';
import { NEEDS_YOU_LANE_ID, withoutNeedsYouLane } from '../lib/obligations/brief-region';
import type { ObligationAction, ObligationView } from '../lib/obligations/contract';
import { UNDO_WINDOW_MS } from '../lib/obligations/contract';
import {
  NEEDS_YOU_FIXTURE_NOW,
  NEEDS_YOU_FIXTURE_TIMEZONE,
  NEEDS_YOU_FIXTURE_WORK_ID,
  needsYouEditorialFixture,
  needsYouFixture,
  needsYouLetterFixture,
} from '../lib/obligations/fixtures';
import { groupNeedsYou, laterOptions } from '../lib/obligations/groups';
import {
  areaChooserSentence,
  calendarEventKey,
  isOpenObligation,
  mailThreadKey,
  needsYouPages,
  obligationNeedsYouRows,
  obligationsByEvent,
  obligationsByThread,
  obligationsByWork,
  occurrenceObligations,
  owedByWork,
  searchNeedsYouItems,
  TODAY_NEEDS_YOU_CAP,
  tabTitle,
  threadStripWords,
} from '../lib/obligations/surfaces';
import { todayRows } from '../lib/obligations/today-page';

/* Needs you where the owner does the work (docs/research/needs-you-web-2-design-2026-11-02.md). */

const NOW = NEEDS_YOU_FIXTURE_NOW;
const TZ = NEEDS_YOU_FIXTURE_TIMEZONE;
const fixture = needsYouFixture(NOW, TZ);
const extras = fixture.extras as unknown as NotificationItem[];
const byId = (id: string) => fixture.items.find((item) => item.id === id) as ObligationView;
const doc = (html: string) => new JSDOM(html).window.document;
const groups = groupNeedsYou(fixture.items, extras, NOW, TZ);

describe('the Today list rules', () => {
  test('the list keeps the group order, leaves out Waiting and Closed today, and stops at the cap', () => {
    const list = todayRows(groups);
    expect(list.rows.length).toBe(TODAY_NEEDS_YOU_CAP);
    const ids = list.rows.map((row) => row.entry.id);
    // Now first: the code, the moved flight, the Albatross question.
    expect(ids.slice(0, 3)).toEqual(expect.arrayContaining(['ob_code_now', 'ob_flight', 'question:q_deck']));
    expect(ids).not.toContain('ob_lease');
    expect(ids).not.toContain('ob_kickoff');
  });

  test('a short list shows every row', () => {
    expect(todayRows(groups, 100).more).toBe(0);
  });
});

describe('the lookups', () => {
  test('open and expired-snooze items count as open; closed and snoozed-ahead ones do not', () => {
    expect(isOpenObligation(byId('ob_sow'), NOW)).toBe(true);
    expect(isOpenObligation(byId('ob_kickoff'), NOW)).toBe(false);
    expect(isOpenObligation({ ...byId('ob_sow'), state: 'snoozed', snoozedUntil: NOW + 1 }, NOW)).toBe(false);
    expect(isOpenObligation({ ...byId('ob_sow'), state: 'snoozed', snoozedUntil: NOW - 1 }, NOW)).toBe(true);
  });

  test('mail threads map to their open items, codes and closed items stay out', () => {
    const map = obligationsByThread(fixture.items, NOW);
    expect(map.get(mailThreadKey('acct_alex', 'thr_dana_sow'))?.map((item) => item.id)).toEqual(['ob_sow']);
    expect(map.has(mailThreadKey('acct_alex', 'thr_bank_code_2'))).toBe(false);
    expect(map.has(mailThreadKey('acct_alex', 'thr_tomas_kickoff'))).toBe(false);
    expect(map.has('slack:T01:C_RELEASE:1730131320')).toBe(false);
  });

  test('a series answer belongs to the occurrence that starts at its time', () => {
    const start = Date.parse('2031-01-02T15:00:00Z');
    const base = fixture.items.find((item) => item.eventId === 'evt_harbor_followup')!;
    const rsvp = {
      ...base,
      id: 'ob_series',
      kind: 'rsvp' as const,
      accountId: 'a',
      eventId: 'master',
      eventStart: start,
    };
    const prepare = {
      ...base,
      id: 'ob_prepare',
      kind: 'prepare' as const,
      accountId: 'a',
      eventId: 'inst_1',
      eventStart: start,
    };
    const byEvent = obligationsByEvent([rsvp, prepare], NOW);
    const at = (id: string, startDate: string) =>
      occurrenceObligations(byEvent, { accountId: 'a', id, masterEventId: 'master', startDate }).map(
        (item) => item.id,
      );
    expect(at('inst_1', '2031-01-02T15:00:00Z')).toEqual(['ob_series', 'ob_prepare']);
    expect(at('inst_2', '2031-01-09T15:00:00Z')).toEqual([]);
    expect(occurrenceObligations(byEvent, { id: 'inst_1' })).toEqual([]);
    expect(occurrenceObligations(byEvent, { accountId: 'a', id: 'inst_1' }).map((item) => item.id)).toEqual([
      'ob_prepare',
    ]);
  });

  test('events map to their rsvp and prepare items; Albatrosses map to their open items', () => {
    const events = obligationsByEvent(fixture.items, NOW);
    const eventKey = (id: string) => {
      const item = fixture.items.find((entry) => entry.eventId === id);
      return calendarEventKey(String(item?.accountId), id);
    };
    expect(events.get(eventKey('evt_harbor_followup'))?.[0].kind).toBe('rsvp');
    expect(events.get(eventKey('evt_board_checkin'))?.[0].kind).toBe('prepare');
    // Another account can hold an event with the same id: its items stay apart.
    const twin = { ...fixture.items.find((entry) => entry.eventId === 'evt_harbor_followup')! };
    const split = obligationsByEvent(
      [...fixture.items, { ...twin, id: 'ob_twin', accountId: 'acct_other' }],
      NOW,
    );
    expect(split.get(calendarEventKey('acct_other', 'evt_harbor_followup'))?.map((item) => item.id)).toEqual([
      'ob_twin',
    ]);
    expect(split.get(eventKey('evt_harbor_followup'))?.map((item) => item.id)).not.toContain('ob_twin');
    const works = obligationsByWork(fixture.items, NOW);
    const deck = works.get(NEEDS_YOU_FIXTURE_WORK_ID)?.map((item) => item.id) ?? [];
    expect(deck).toContain('ob_slack_numbers');
    expect(deck).toContain('ob_prepare');
    // Closed today: not open.
    expect(deck).not.toContain('ob_numbers');
    // Oldest first.
    expect(deck[0]).toBe('ob_prepare');
  });

  test('the reader strip leads with the first item and counts the rest', () => {
    expect(threadStripWords([])).toBeNull();
    expect(threadStripWords([byId('ob_sow'), byId('ob_nda')])).toEqual({ lead: byId('ob_sow'), others: 1 });
  });
});

describe('the areas', () => {
  test('ledger items of the area Albatrosses become rows with Open thread; other items stay out', () => {
    const rows = obligationNeedsYouRows(
      obligationsByWork(fixture.items, NOW),
      [NEEDS_YOU_FIXTURE_WORK_ID, 'work_other'],
      new Map([[NEEDS_YOU_FIXTURE_WORK_ID, 'Q3 review deck']]),
    );
    expect(rows.map((row) => row.obligationId)).toEqual(['ob_prepare', 'ob_slack_numbers']);
    expect(rows[1]).toMatchObject({
      id: 'obligation:ob_slack_numbers',
      kind: 'obligation',
      workId: NEEDS_YOU_FIXTURE_WORK_ID,
      detail: 'Priya Raman, in Q3 review deck',
    });
    expect(obligationNeedsYouRows(new Map(), ['w'])).toEqual([]);
  });

  test('the chooser sentence says what it counts', () => {
    expect(areaChooserSentence(0)).toBe('');
    expect(areaChooserSentence(1)).toBe('1 plan or task needs you across your areas.');
    expect(areaChooserSentence(3)).toBe('3 plans and tasks need you across your areas.');
    const source = readFileSync('components/albatross/AreaHome.tsx', 'utf8');
    expect(source).toContain('areaChooserSentence(totals.needsYou)');
    expect(source).toContain('obligationNeedsYouRows(');
    expect(source).toContain("row.kind === 'obligation' && row.workId");
  });

  test('an item that waits on someone else stays out of what the user owes', () => {
    const owed = byId('ob_flight');
    const waits = fixture.items.find((item) => item.kind === 'waiting')!;
    const byWork = owedByWork(
      [
        { ...owed, workId: 'w1' },
        { ...waits, workId: 'w1' },
      ],
      NOW,
    );
    expect(byWork.get('w1')?.map((item) => item.id)).toEqual([owed.id]);
  });

  test('the generated brief and the artifact of an area show the ledger rows too', () => {
    const source = readFileSync('components/albatross/AreaHome.tsx', 'utf8');
    expect(source.match(/brief=\{withLedger\(/g)).toHaveLength(2);
    expect(source).toContain('<NeedsYouSection rows={ledgerRows} bounded={ledgerBounded} />');
    expect(source).toContain('max-h-[45%] shrink-0 overflow-y-auto');
  });
});

describe('the thread rail rows', () => {
  const row = (over: Partial<ThreadRow>): ThreadRow => ({
    workId: 'w1',
    title: 'Q3 review deck',
    areaName: null,
    status: 'idle',
    statusLabel: 'Open',
    preview: 'Nothing is in motion.',
    stepTitle: null,
    nextLabel: null,
    blanks: [],
    needsYou: false,
    working: false,
    latestRunId: null,
    workingRunId: null,
    runStartedAt: null,
    lastActivityAt: NOW - 3_600_000,
    seenAt: null,
    unread: false,
    closed: false,
    ...over,
  });
  const items = new Map([['w1', [{ title: 'Asks for the Q3 numbers.', createdAt: NOW - 60_000 }]]]);

  test('an idle thread with an open item joins Needs you with "Your turn" and the item title', () => {
    const [out] = applyObligationsToThreadRows([row({})], items);
    expect(out.needsYou).toBe(true);
    expect(out.status).toBe('your_turn');
    expect(out.statusLabel).toBe(THREAD_ROW_ITEM_WORD);
    expect(out.preview).toBe('Asks for the Q3 numbers.');
    expect(out.lastActivityAt).toBe(NOW - 60_000);
  });

  test('a thread that already waits, works, or is closed keeps its words', () => {
    const waits = row({ status: 'needs_answer', statusLabel: 'Needs an answer', needsYou: true });
    expect(applyObligationsToThreadRows([waits], items)[0].statusLabel).toBe('Needs an answer');
    const works = row({ status: 'in_progress', statusLabel: 'In progress', working: true });
    expect(applyObligationsToThreadRows([works], items)[0]).toMatchObject({
      statusLabel: 'In progress',
      needsYou: false,
    });
    const closed = row({ closed: true });
    expect(applyObligationsToThreadRows([closed], items)[0]).toBe(closed);
    expect(applyObligationsToThreadRows([row({ workId: 'w2' })], items)[0].needsYou).toBe(false);
    expect(applyObligationsToThreadRows([row({})], new Map())[0].needsYou).toBe(false);
  });

  test('the rail and the hop keys read the same rows from the shared snapshot', () => {
    const rail = readFileSync('components/albatross/ThreadRail.tsx', 'utf8');
    expect(rail).toContain('useNeedsYouSnapshot()');
    expect(rail).toContain('applyObligationsToThreadRows(rawRows, owedByWork(snapshot.items, nowMs))');
    const thread = readFileSync('components/albatross/WorkThread.tsx', 'utf8');
    expect(thread).toContain('useThreadRowsWithItems(useThreadRows(awakeWorks), railNowMs)');
  });

  test('a row that an item promotes takes its place by time among the rows that need the user', () => {
    const older = row({ workId: 'older', needsYou: true, status: 'your_turn', lastActivityAt: 100 });
    const idle = row({ workId: 'idle', lastActivityAt: 50 });
    const out = applyObligationsToThreadRows(
      [older, idle],
      new Map([['idle', [{ title: 'New item', createdAt: 200 }]]]),
    );
    expect(out.map((item) => item.workId)).toEqual(['idle', 'older']);
  });
});

describe('the thread extras', () => {
  type Message = { id: string };
  const timeline: ThreadTimelineItem<Message>[] = [
    { kind: 'message', at: null, message: { id: 'old' } },
    { kind: 'message', at: 100, message: { id: 'a' } },
    { kind: 'message', at: 300, message: { id: 'b' } },
  ];

  test('extras sit between the items by time; earlier ones after the timeless items; later ones last', () => {
    const out = interleaveThreadExtras(timeline, [
      { id: 'x3', at: 500 },
      { id: 'x1', at: 50 },
      { id: 'x2', at: 300 },
    ]);
    expect(
      out.map((item) =>
        item.kind === 'extra'
          ? `extra:${item.extra.id}`
          : `${item.kind}:${(item as { message: Message }).message.id}`,
      ),
    ).toEqual(['message:old', 'extra:x1', 'message:a', 'message:b', 'extra:x2', 'extra:x3']);
    expect(interleaveThreadExtras(timeline, [])).toEqual(timeline);
  });

  test('the thread passes its items as extras, and the chat renders them in place', () => {
    const thread = readFileSync('components/albatross/WorkThread.tsx', 'utf8');
    expect(thread).toContain('extras: obligationExtras');
    expect(thread).not.toContain('<ThreadObligations');
    const chat = readFileSync('components/shell/AIBar.tsx', 'utf8');
    expect(chat).toContain('interleaveThreadExtras(timeline, thread?.extras ?? [])');
    expect(chat).toContain('data-timeline-extra');
  });
});

describe('the stored lane hides under the live list', () => {
  test('the letter loses the needs-you region and nothing else', () => {
    const letter = needsYouLetterFixture();
    const out = withoutNeedsYouLane(letter);
    expect(out.regions.map((region) => region.id)).toEqual(
      letter.regions.map((region) => region.id).filter((id) => id !== NEEDS_YOU_LANE_ID),
    );
    expect(withoutNeedsYouLane(out)).toBe(out);
  });

  test('the editorial edition loses the lane module wherever the writer placed it', () => {
    const editorial = needsYouEditorialFixture();
    const before = JSON.stringify(editorial);
    expect(before).toContain('"title":"Needs you"');
    const out = withoutNeedsYouLane(editorial);
    expect(JSON.stringify(out)).not.toContain('"title":"Needs you"');
    expect(out.regions.length).toBeGreaterThan(0);
  });

  test('the brief canvas renders the live layer under the masthead and hides the lane for the current edition', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const render = (live: boolean) =>
      renderToStaticMarkup(
        <QueryClientProvider client={queryClient}>
          <BriefLiveLayer.Provider value={{ node: <p data-live-list>Live</p>, hideNeedsYou: true }}>
            <BriefCanvas value={needsYouLetterFixture()} liveSections={live} />
          </BriefLiveLayer.Provider>
        </QueryClientProvider>,
      );
    const current = doc(render(true));
    expect(current.querySelector('[data-brief-live-layer] [data-live-list]')).not.toBeNull();
    expect(current.querySelector('[data-brief-region="needs-you"]')).toBeNull();
    // An old edition: the stored lane stays, and the live list does not show.
    const old = doc(render(false));
    expect(old.querySelector('[data-brief-live-layer]')).toBeNull();
    expect(old.querySelector('[data-brief-region="needs-you"]')).not.toBeNull();
  });

  test('a split or a grid that loses the lane keeps a valid shape, and other trees stay as they are', () => {
    const text = (value: string) => ({ kind: 'text', role: 'body', text: value }) as any;
    const lane = { kind: 'group', title: 'Needs you', children: [text('row')] } as any;
    const base = needsYouLetterFixture();
    const withTrees = (trees: Record<string, unknown>) => ({
      ...base,
      regions: Object.entries(trees).map(([id, tree]) => ({ ...base.regions[0], id, tree })),
    });
    const out = withoutNeedsYouLane(
      withTrees({
        leaf: text('stays'),
        kept: { kind: 'stack', children: [text('a'), text('b')] },
        split: { kind: 'split', children: [lane, text('alone')] },
        grid: { kind: 'grid', children: [lane, text('alone')] },
        stack: { kind: 'stack', children: [lane, text('stays'), text('too')] },
        gone: { kind: 'stack', children: [lane] },
      }) as any,
    );
    const tree = (id: string) => out.regions.find((region) => region.id === id)?.tree as any;
    expect(tree('leaf').kind).toBe('text');
    expect(tree('kept').children).toHaveLength(2);
    expect(tree('split')).toEqual(text('alone'));
    expect(tree('grid')).toEqual(text('alone'));
    expect(tree('stack').children).toHaveLength(2);
    expect(out.regions.map((region) => region.id)).not.toContain('gone');
  });

  test('Today mounts the layer around the brief', () => {
    const today = readFileSync('components/report/Today.tsx', 'utf8');
    expect(today).toContain('<TodayNeedsYouLayer>');
  });
});

describe('the routes to the page', () => {
  test('g n is in the sheet and the binding', () => {
    expect(SHORTCUTS).toContainEqual([['g', 'n'], 'Go to Needs you']);
    const binding = readFileSync('components/shell/ShortcutsBinding.tsx', 'utf8');
    expect(binding).toMatch(
      /e\.key === 'n'\) \{\s+e\.preventDefault\(\);\s+setPrimaryView\('notifications'\)/,
    );
  });

  test('the palette finds open items by title, asker, or place, never a code', () => {
    const entries = groups.flatMap((group) => group.entries);
    expect(searchNeedsYouItems(entries, 'Q3 numbers').map((hit) => hit.obligationId)).toContain(
      'ob_slack_numbers',
    );
    expect(searchNeedsYouItems(entries, 'northwind bank')).toEqual([]);
    expect(searchNeedsYouItems(entries, '#release')[0]).toMatchObject({
      id: 'needs-you:ob_slack_numbers',
      detail: 'Priya Raman, #release',
    });
    expect(searchNeedsYouItems(entries, '')).toEqual([]);
    expect(searchNeedsYouItems(entries, 'a', 2).length).toBeLessThanOrEqual(2);
    const palette = readFileSync('components/palette/CommandPalette.tsx', 'utf8');
    expect(palette).toContain('searchNeedsYouItems(');
    expect(palette).toContain('heading="Needs you"');
  });

  test('the page entry takes the name a flag user knows', () => {
    const pages = [
      { id: 'page:notifications', title: 'Notifications', detail: 'x' },
      { id: 'page:mail', title: 'Mail', detail: 'y' },
    ];
    expect(needsYouPages(pages, false)).toEqual(pages);
    expect(needsYouPages(pages, true)[0]).toMatchObject({ title: 'Needs you' });
    expect(needsYouPages(pages, true)[1]).toEqual(pages[1]);
  });

  test('the tab title carries the Now count', () => {
    expect(tabTitle('Albatross', 0)).toBe('Albatross');
    expect(tabTitle('Albatross', 3)).toBe('(3) Albatross');
    expect(readFileSync('components/needs-you/RailNeedsYouRow.tsx', 'utf8')).toContain(
      'useNeedsYouTabTitle(',
    );
  });
});

// ---- Components ------------------------------------------------------------

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

function todayProps(overrides: Partial<TodayNeedsYouProps> = {}) {
  const actions: { id: string; action: ObligationAction }[] = [];
  const opened: string[] = [];
  const replies: string[] = [];
  const props: TodayNeedsYouProps = {
    items: fixture.items,
    extras,
    timezone: TZ,
    now: NOW,
    post: async (obligation, action) => {
      actions.push({ id: obligation.id, action });
      const at = NOW + 60_000;
      const next: ObligationView =
        action.action === 'undo'
          ? { ...byId(obligation.id), updatedAt: at }
          : action.action === 'later'
            ? { ...obligation, state: 'snoozed', snoozedUntil: action.until, updatedAt: at }
            : { ...obligation, state: 'done', closedAt: at, closeReason: 'user_done', updatedAt: at };
      return {
        obligation: next,
        undoUntil: action.action === 'undo' ? undefined : Date.now() + UNDO_WINDOW_MS,
      };
    },
    loadDraft: async (obligation) => ({ draft: fixture.drafts[obligation.id] }),
    sendReply: async (obligation, body) => {
      replies.push(body);
      return {
        obligation: { ...obligation, state: 'done', closeReason: 'sent_reply', updatedAt: NOW + 60_000 },
        undoUntil: Date.now() + UNDO_WINDOW_MS,
      };
    },
    startAlbatross: async (obligation) => ({ workId: 'w', created: false, obligation }),
    copyText: async () => undefined,
    onOpenItem: (id) => {
      opened.push(id);
    },
    onOpenPage: () => {
      opened.push('page');
    },
    onOpenWork: () => undefined,
    onAlbatrossAction: () => undefined,
    ...overrides,
  };
  return { props, actions, opened, replies };
}

describe('the Today list', () => {
  const page = doc(renderToStaticMarkup(<TodayNeedsYou {...todayProps().props} />));

  test('it shows the capped rows with their actions in view, the count, and the way to the rest', () => {
    const head = page.querySelector('[data-today-needs-you] h2')?.textContent ?? '';
    expect(head).toBe('Needs you');
    expect(page.querySelectorAll('[data-needs-you-row]').length).toBe(TODAY_NEEDS_YOU_CAP);
    const texts = [...page.querySelectorAll('[data-needs-you-row] button')].map((node) => node.textContent);
    expect(texts).toContain('Done');
    expect(texts).toContain('Later');
    expect(texts).toContain('Copy');
    expect(page.querySelector('[data-today-more]')?.textContent).toMatch(/^View all \d+$/);
    // No group labels, no code value outside the code row.
    expect(page.querySelector('h2 + ul h2')).toBeNull();
  });

  test('it takes no space when nothing is open', () => {
    const closedOnly = fixture.items.filter((item) => item.state !== 'open');
    expect(
      renderToStaticMarkup(<TodayNeedsYou {...todayProps({ items: closedOnly, extras: [] }).props} />),
    ).toBe('');
  });
});

describe('the Today list acts in place', () => {
  useBrowserGlobals();
  beforeAll(() => {
    setSystemTime(new Date(NOW));
  });
  afterAll(() => {
    setSystemTime();
  });
  // Four items: a code, a moved flight, a review, and a reply with a draft. All fit under the cap.
  const few = ['ob_code_now', 'ob_flight', 'ob_review', 'ob_sow'].map(byId);
  const mounted: ReactTestRenderer[] = [];
  const mount = async (props: TodayNeedsYouProps) => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<TodayNeedsYou {...props} />);
    });
    mounted.push(renderer);
    return renderer;
  };
  // A row holds a menu. Its cleanup needs the browser globals, so it runs before they leave.
  afterEach(async () => {
    await act(async () => {
      for (const renderer of mounted.splice(0)) renderer.unmount();
    });
  });
  const rowOf = (renderer: ReactTestRenderer, id: string) =>
    renderer.root.findAll((node) => node.type === 'li' && node.props['data-needs-you-row'] === id)[0];
  const button = (renderer: ReactTestRenderer, id: string, label: string) =>
    rowOf(renderer, id).findAll((node) => node.type === 'button' && node.props.children === label)[0];

  test('an answer to an invitation closes with no Undo', async () => {
    const { props } = todayProps({ items: [byId('ob_rsvp')], extras: [] });
    const renderer = await mount(props);
    await act(async () => {
      button(renderer, 'ob_rsvp', 'Accept').props.onClick({ stopPropagation() {} });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(
      rowOf(renderer, 'ob_rsvp').findAll((node) => node.props['data-needs-you-undo'] !== undefined),
    ).toHaveLength(0);
  });

  test('a failed copy does not say Copied', async () => {
    const { props } = todayProps({ items: few, extras: [] });
    const renderer = await mount({
      ...props,
      copyText: async () => {
        throw new Error('denied');
      },
    });
    await act(async () => {
      button(renderer, 'ob_code_now', 'Copy').props.onClick({ stopPropagation() {} });
      await Promise.resolve();
    });
    expect(button(renderer, 'ob_code_now', 'Copied')).toBeUndefined();
  });

  test('the count holds the rows of the list, not the items that wait on others', async () => {
    const waiting = fixture.items.find((item) => item.kind === 'waiting');
    expect(waiting).toBeDefined();
    const { props } = todayProps({ items: [byId('ob_flight'), waiting!], extras: [] });
    const renderer = await mount(props);
    expect(
      renderer.root.findAll((node) => node.props['data-needs-you-row'] !== undefined && node.type === 'li'),
    ).toHaveLength(1);
  });

  test('Done on a row of notices closes each notice of the sender, and Undo brings them all back', async () => {
    const notice = (id: string, createdAt: number): ObligationView => ({
      ...byId('ob_card'),
      id,
      kind: 'change',
      asker: 'Lumen Hosting',
      sourceKey: `mail:acct:${id}`,
      createdAt,
      updatedAt: createdAt,
    });
    const items = [notice('n1', NOW - 1000), notice('n2', NOW - 2000), notice('n3', NOW - 3000)];
    const { props, actions } = todayProps({
      items,
      extras: [],
      post: async (obligation, action) => ({
        obligation:
          action.action === 'undo'
            ? { ...obligation, state: 'open', updatedAt: NOW + 120_000 }
            : {
                ...obligation,
                state: 'done',
                closedAt: NOW,
                closeReason: 'user_done',
                updatedAt: NOW + 60_000,
              },
        undoUntil: action.action === 'undo' ? undefined : Date.now() + UNDO_WINDOW_MS,
      }),
    });
    const logged: string[] = [];
    const post = props.post!;
    const renderer = await mount({
      ...props,
      post: async (obligation, action) => {
        logged.push(`${action.action}:${obligation.id}`);
        return post(obligation, action);
      },
    });
    expect(actions).toEqual([]);
    expect(
      renderer.root.findAll((node) => node.type === 'li' && node.props['data-needs-you-row']),
    ).toHaveLength(1);
    await act(async () => {
      button(renderer, 'n1', 'Done').props.onClick({ stopPropagation() {} });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(logged.sort()).toEqual(['done:n1', 'done:n2', 'done:n3']);
    const undo = rowOf(renderer, 'n1').findAll((node) => node.props['data-needs-you-undo'] !== undefined)[0];
    await act(async () => {
      undo.props.onClick({ stopPropagation() {} });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(logged.filter((entry) => entry.startsWith('undo')).sort()).toEqual([
      'undo:n1',
      'undo:n2',
      'undo:n3',
    ]);
  });

  test('Done closes the row at once, keeps it in place with Undo, and Undo brings it back', async () => {
    const { props, actions } = todayProps({ items: few, extras: [] });
    const renderer = await mount(props);
    await act(async () => {
      button(renderer, 'ob_review', 'Done').props.onClick({ stopPropagation() {} });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(actions).toEqual([{ id: 'ob_review', action: { action: 'done' } }]);
    const undo = rowOf(renderer, 'ob_review').findAll(
      (node) => node.props['data-needs-you-undo'] !== undefined,
    )[0];
    expect(undo).toBeDefined();
    expect(
      rowOf(renderer, 'ob_review').findAll((node) => node.type === 'span' && node.props.children === 'Done')
        .length,
    ).toBe(1);
    await act(async () => {
      undo.props.onClick({ stopPropagation() {} });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(actions.at(-1)).toEqual({ id: 'ob_review', action: { action: 'undo' } });
    expect(button(renderer, 'ob_review', 'Done')).toBeDefined();
  });

  test('Later puts the row off through the row menu and says Later with Undo', async () => {
    const { props, actions } = todayProps({ items: few, extras: [] });
    const renderer = await mount(props);
    const options = laterOptions(NOW, TZ);
    const row = rowOf(renderer, 'ob_flight');
    expect(row.findAll((node) => node.props['data-needs-you-later'] !== undefined).length).toBe(1);
    // The menu item calls the row's onLater; Radix does not open its content under the test renderer.
    const rowNode = renderer.root.findAll(
      (node) => node.type === NeedsYouRow && node.props.entry.id === 'ob_flight',
    )[0];
    await act(async () => {
      rowNode.props.onLater(options[0]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(actions[0]).toEqual({ id: 'ob_flight', action: { action: 'later', until: options[0].until } });
    expect(
      rowOf(renderer, 'ob_flight').findAll((node) => node.type === 'span' && node.props.children === 'Later')
        .length,
    ).toBe(1);
  });

  test('Reply opens the prepared draft under the row and Send reply sends it', async () => {
    const { props, replies } = todayProps({ items: few, extras: [] });
    const renderer = await mount(props);
    await act(async () => {
      button(renderer, 'ob_sow', 'Reply').props.onClick({ stopPropagation() {} });
    });
    const card = renderer.root.findAll((node) => node.props['data-today-reply'] === 'ob_sow')[0];
    expect(card).toBeDefined();
    const field = card.findAll((node) => node.type === 'textarea')[0];
    expect(field.props.value).toContain('November 16');
    const send = card.findAll((node) => node.type === 'button' && node.props.children === 'Send reply')[0];
    await act(async () => {
      send.props.onClick();
    });
    expect(replies.length).toBe(1);
    expect(renderer.root.findAll((node) => node.props['data-today-reply'] === 'ob_sow').length).toBe(0);
    expect(
      rowOf(renderer, 'ob_sow').findAll((node) => node.props['data-needs-you-undo'] !== undefined).length,
    ).toBe(1);
  });

  test('the row itself opens the item on the page; the link under the list opens the page', async () => {
    const { props, opened } = todayProps({ items: few, extras: [] });
    const renderer = await mount(props);
    await act(async () => {
      rowOf(renderer, 'ob_sow')
        .findAll((node) => node.type === 'button')[0]
        .props.onClick();
    });
    expect(opened).toEqual(['ob_sow']);
    const full = await mount(todayProps({ onOpenPage: () => opened.push('page') }).props);
    const foot = full.root.findAll(
      (node) => node.type === 'button' && node.props['data-today-more'] !== undefined,
    )[0];
    await act(async () => {
      foot.props.onClick();
    });
    expect(opened).toEqual(['ob_sow', 'page']);
  });
});

describe('the reader strip', () => {
  const dana = [byId('ob_sow')];
  const html = renderToStaticMarkup(
    <ThreadNeedsYouStrip items={dana} now={NOW} timezone={TZ} onDraftReply={() => {}} onOpen={() => {}} />,
  );
  const page = doc(html);

  test('it says what the user owes, why, and offers Draft reply, Done, Later as text', () => {
    const strip = page.querySelector('[data-thread-needs-you="ob_sow"]');
    expect(strip).not.toBeNull();
    expect(strip?.textContent).toContain(THREAD_STRIP_COPY.kicker);
    expect(strip?.textContent).toContain(byId('ob_sow').title);
    expect(strip?.textContent).toContain(byId('ob_sow').why as string);
    const labels = [...(strip?.querySelectorAll('button') ?? [])].map((node) => node.textContent);
    expect(labels).toEqual([THREAD_STRIP_COPY.draftReply, THREAD_STRIP_COPY.done, THREAD_STRIP_COPY.later]);
    expect(strip?.querySelector('button svg')).toBeNull();
  });

  test('a thread without an open item has no strip; a closed item does not count', () => {
    expect(
      renderToStaticMarkup(
        <ThreadNeedsYouStrip
          items={[byId('ob_kickoff')]}
          now={NOW}
          timezone={TZ}
          onDraftReply={() => {}}
          onOpen={() => {}}
        />,
      ),
    ).toBe('');
  });

  test('the reader mounts the strip under the title bar and the inbox marks the row from one map', () => {
    const reader = readFileSync('components/thread/ThreadView.tsx', 'utf8');
    expect(reader).toContain('<ThreadNeedsYou accountId={account || null} threadId={threadId} />');
    const inbox = readFileSync('components/inbox/Inbox.tsx', 'utf8');
    expect(inbox).toContain('const needsYouMarks = useNeedsYouThreadMarks();');
    expect(inbox).toContain('needsYou={needsYouMarks.get(mailThreadKey(rowAccount, it._id))}');
    expect(inbox).toContain('data-needs-you-mark');
  });
});

describe('the calendar', () => {
  const ACCOUNT = String(fixture.items.find((item) => item.eventId === 'evt_harbor_followup')?.accountId);
  const html = renderToStaticMarkup(
    <CalendarNeedsYouItems items={fixture.items} now={NOW} timezone={TZ}>
      <EventNeedsYouMark event={{ accountId: ACCOUNT, id: 'evt_harbor_followup' }} />
      <EventNeedsYouMark event={{ accountId: ACCOUNT, id: 'evt_plain' }} />
      <EventNeedsYou event={{ accountId: ACCOUNT, id: 'evt_harbor_followup' }} />
      <EventNeedsYou event={{ accountId: ACCOUNT, id: 'evt_board_checkin' }} />
    </CalendarNeedsYouItems>,
  );
  const page = doc(html);

  test('an event with an item gets one mark; the dialog shows Yes No Maybe for an invitation and Done for preparation', () => {
    expect(page.querySelectorAll('[data-needs-you-event-mark]').length).toBe(1);
    const rsvp = page.querySelector('[data-event-obligation="ob_rsvp"]');
    const labels = [...(rsvp?.querySelectorAll('button') ?? [])].map((node) => node.textContent);
    expect(labels).toEqual([
      CALENDAR_NEEDS_YOU_COPY.yes,
      CALENDAR_NEEDS_YOU_COPY.no,
      CALENDAR_NEEDS_YOU_COPY.maybe,
      CALENDAR_NEEDS_YOU_COPY.later,
    ]);
    expect(rsvp?.textContent).toContain(CALENDAR_NEEDS_YOU_COPY.rsvpNote);
    const prepare = page.querySelector('[data-event-obligation="ob_prepare"]');
    expect([...(prepare?.querySelectorAll('button') ?? [])].map((node) => node.textContent)).toEqual([
      CALENDAR_NEEDS_YOU_COPY.done,
      CALENDAR_NEEDS_YOU_COPY.later,
    ]);
  });

  test('the surface, the dialog, and the block are wired', () => {
    expect(readFileSync('components/calendar/CalendarSurface.tsx', 'utf8')).toContain(
      '<CalendarNeedsYouProvider>',
    );
    expect(readFileSync('components/calendar/engine/event-details-dialog.tsx', 'utf8')).toContain(
      '<EventNeedsYou event={event} />',
    );
    expect(readFileSync('components/calendar/engine/event-block.tsx', 'utf8')).toContain(
      '<EventNeedsYouMark event={event} />',
    );
  });
});

describe('the palette', () => {
  test('the Needs you read sits outside the search state, so a failure keeps what the user typed', () => {
    const source = readFileSync('components/palette/CommandPalette.tsx', 'utf8');
    expect(source).toContain('<NeedsYouGate fallback={null}>');
    expect(source).toContain('<NeedsYouFeed onData={setNeedsYou} />');
  });
});

describe('the row grammar', () => {
  test('the page row gains a Later pill when it gets options, and keeps the hover rule', () => {
    const entry = { type: 'obligation' as const, id: 'ob_sow', obligation: byId('ob_sow') };
    const html = renderToStaticMarkup(
      <ul>
        <NeedsYouRow
          entry={entry}
          now={NOW}
          timezone={TZ}
          selected={false}
          focusable
          onOpen={() => {}}
          onKeyDown={() => {}}
          onDone={() => {}}
          laterOptions={laterOptions(NOW, TZ)}
          onLater={() => {}}
          registerRef={() => {}}
        />
      </ul>,
    );
    const page = doc(html);
    expect(page.querySelector('[data-needs-you-later]')).not.toBeNull();
    expect(page.querySelector('[data-needs-you-due]')?.className).toContain('group-hover:invisible');
  });
});
