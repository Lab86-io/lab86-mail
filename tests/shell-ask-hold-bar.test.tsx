import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import {
  AskHoldComposer,
  BAR_PLACEHOLDER,
  barKeyAction,
  type DoorRequest,
} from '../components/shell/AskHoldComposer';
import {
  HOLD_CARD_MS,
  HOLD_COLLAPSE_MS,
  HOLD_LEAVE_MS,
  HOLD_STAGGER_MS,
  HoldLanding,
  holdLeaveDuration,
  holdOffsetToward,
  holdTitleFromText,
} from '../components/shell/HoldLanding';
import { HOLD_THIS_KEPT, HOLD_THIS_LABEL, HoldThisControl } from '../components/shell/HoldThisControl';
import { RouteChip, routeChipLabel } from '../components/shell/RouteChip';
import { type RoutePrediction, useRoutePrediction } from '../components/shell/useRoutePrediction';
import {
  HOLD_ERROR,
  type HoldCard,
  type HoldInput,
  holdCardsFromResponse,
  holdText,
  kickAdvance,
  resolveGeo,
} from '../lib/albatross/capture-client';
import type { BarRoute, RouteVerdict } from '../lib/albatross/route-classifier';
import { flipRoute, instantRoute, predictRoute, ROUTE_CONFIRM_DELAY_MS } from '../lib/albatross/route-client';

const NOW = new Date(2026, 8, 3, 10, 0, 0, 0).getTime();
const DAY = 24 * 60 * 60_000;

const verdict = (route: BarRoute, confidence = 0.9): RouteVerdict => ({
  route,
  confidence,
  reason: 'endpoint',
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const flush = () => act(async () => {});

/* ------------------------------------------------------------------ */
/* The route client                                                    */
/* ------------------------------------------------------------------ */

describe('the route client', () => {
  test('the instant route is the heuristic, or the current chip when unclear', () => {
    expect(instantRoute('what did Sarah say about the venue?').route).toBe('ask');
    expect(instantRoute('book the dentist before the trip').route).toBe('hold');
    expect(instantRoute('the venue', 'hold')).toEqual({ route: 'hold', confidence: 0, reason: 'unclear' });
    expect(instantRoute('   ').route).toBe('ask');
    expect(flipRoute('ask')).toBe('hold');
    expect(flipRoute('hold')).toBe('ask');
  });

  test('the endpoint answer wins, and every failure is Ask', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: String(init?.body) });
      return jsonResponse({ ok: true, route: 'hold', confidence: 0.7 });
    }) as unknown as typeof fetch;
    expect(await predictRoute('  ship the box ', { fetchImpl })).toEqual({
      route: 'hold',
      confidence: 0.7,
      reason: 'endpoint',
    });
    expect(calls[0].url).toBe('/api/albatross/route');
    expect(JSON.parse(calls[0].body)).toEqual({ text: 'ship the box' });

    const bad = (async () => jsonResponse({ ok: true, route: 'maybe' })) as unknown as typeof fetch;
    expect((await predictRoute('x', { fetchImpl: bad })).route).toBe('ask');
    const denied = (async () => jsonResponse({ ok: false }, 429)) as unknown as typeof fetch;
    expect((await predictRoute('x', { fetchImpl: denied })).route).toBe('ask');
    const down = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect((await predictRoute('x', { fetchImpl: down })).route).toBe('ask');
    expect((await predictRoute('   ')).route).toBe('ask');
  });

  test('a timeout is Ask, and an abort from the caller rejects', async () => {
    const slow = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as unknown as typeof fetch;
    expect((await predictRoute('x', { fetchImpl: slow, timeoutMs: 5 })).route).toBe('ask');

    const controller = new AbortController();
    const pending = predictRoute('x', { fetchImpl: slow, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    const dead = new AbortController();
    dead.abort();
    await expect(predictRoute('x', { fetchImpl: slow, signal: dead.signal })).rejects.toBeDefined();
  });
});

/* ------------------------------------------------------------------ */
/* The capture client                                                  */
/* ------------------------------------------------------------------ */

describe('the capture client', () => {
  test('reads the parsed cards, or one card per id, or nothing', () => {
    expect(
      holdCardsFromResponse({
        work: [
          { id: 'a', title: ' Book the dentist ', shape: 'quick', horizon: { kind: 'now' } },
          { id: 'b', title: '', shape: 'nonsense' },
          { id: '', title: 'dropped' },
        ],
      }),
    ).toEqual([
      { id: 'a', title: 'Book the dentist', shape: 'quick', horizon: { kind: 'now' } },
      { id: 'b', title: 'Work', shape: 'quick', horizon: null },
    ]);
    expect(holdCardsFromResponse({ workIds: ['x', ''] })).toEqual([
      { id: 'x', title: 'Work', shape: 'quick', horizon: null },
    ]);
    expect(holdCardsFromResponse({})).toEqual([]);
    expect(holdCardsFromResponse(null)).toEqual([]);
  });

  test('posts a chat capture and returns the cards', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return jsonResponse({
        ok: true,
        status: 'split',
        workIds: ['w1'],
        work: [{ id: 'w1', title: 'Book the dentist', shape: 'quick', horizon: null }],
        existing: false,
      });
    }) as unknown as typeof fetch;
    const result = await holdText(
      { text: ' book the dentist ', conversationId: 'c1', sourceMessageId: 'm1', replyText: 'Sure.' },
      { fetchImpl, timezone: 'UTC' },
    );
    expect(result).toEqual({
      cards: [{ id: 'w1', title: 'Book the dentist', shape: 'quick', horizon: null }],
      existing: false,
    });
    expect(calls[0].url).toBe('/api/albatross/capture');
    expect(calls[0].body).toEqual({
      text: 'book the dentist',
      source: 'chat',
      conversationId: 'c1',
      sourceMessageId: 'm1',
      replyText: 'Sure.',
      timezone: 'UTC',
    });
  });

  test('every failure is one error, so the bar keeps the text', async () => {
    const denied = (async () => jsonResponse({ ok: false, error: 'no' }, 500)) as unknown as typeof fetch;
    await expect(holdText({ text: 'x', conversationId: 'c' }, { fetchImpl: denied })).rejects.toThrow(
      HOLD_ERROR,
    );
    const down = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await expect(holdText({ text: 'x', conversationId: 'c' }, { fetchImpl: down })).rejects.toThrow(
      HOLD_ERROR,
    );
    const empty = (async () => jsonResponse({ ok: true, workIds: [] })) as unknown as typeof fetch;
    await expect(holdText({ text: 'x', conversationId: 'c' }, { fetchImpl: empty })).rejects.toThrow(
      HOLD_ERROR,
    );
    await expect(holdText({ text: '  ', conversationId: 'c' })).rejects.toThrow(HOLD_ERROR);
  });

  test('the location is best-effort: a position, a denial, a throw, or no API', async () => {
    const nav = globalThis.navigator as any;
    const original = Object.getOwnPropertyDescriptor(nav, 'geolocation');
    const install = (getCurrentPosition: unknown) =>
      Object.defineProperty(nav, 'geolocation', { value: { getCurrentPosition }, configurable: true });
    try {
      install((ok: (p: any) => void) => ok({ coords: { latitude: 1, longitude: 2 } }));
      expect(await resolveGeo(50)).toEqual({ latitude: 1, longitude: 2 });
      install((_ok: unknown, fail: () => void) => fail());
      expect(await resolveGeo(50)).toBeNull();
      install(() => {
        throw new Error('no');
      });
      expect(await resolveGeo(50)).toBeNull();
      install(() => {});
      expect(await resolveGeo(5)).toBeNull();
      Object.defineProperty(nav, 'geolocation', { value: undefined, configurable: true });
      expect(await resolveGeo(5)).toBeNull();
    } finally {
      if (original) Object.defineProperty(nav, 'geolocation', original);
      else delete nav.geolocation;
    }
  });

  test('the plan kick posts once per Work with the location when it has one', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;
    await kickAdvance(['a', 'b/c'], {
      fetchImpl,
      timezone: 'UTC',
      geo: async () => ({ latitude: 1, longitude: 2 }),
    });
    expect(calls.map((call) => call.url)).toEqual([
      '/api/albatross/work/a/advance',
      '/api/albatross/work/b%2Fc/advance',
    ]);
    expect(calls[0].body).toEqual({ timezone: 'UTC', geo: { latitude: 1, longitude: 2 } });
    await kickAdvance([], { fetchImpl });
    expect(calls).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */
/* The route prediction hook                                           */
/* ------------------------------------------------------------------ */

type PredictFn = (text: string, options: { signal: AbortSignal }) => Promise<RouteVerdict>;

function Probe({
  text,
  predict,
  handle,
}: {
  text: string;
  predict: PredictFn;
  handle: { current: RoutePrediction | null };
}) {
  const prediction = useRoutePrediction({ text, predict });
  handle.current = prediction;
  return (
    <span
      data-route={prediction.route}
      data-pending={prediction.pending}
      data-locked={prediction.locked}
      data-empty={prediction.empty}
    />
  );
}

function probeState(renderer: ReactTestRenderer) {
  const span = renderer.root.findByType('span');
  return {
    route: span.props['data-route'] as BarRoute,
    pending: span.props['data-pending'] as boolean,
    locked: span.props['data-locked'] as boolean,
    empty: span.props['data-empty'] as boolean,
  };
}

describe('the route prediction', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  async function mountProbe(text: string, predict: PredictFn) {
    const handle = { current: null as RoutePrediction | null };
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Probe text={text} predict={predict} handle={handle} />);
    });
    const type = async (next: string) => {
      await act(async () => {
        renderer.update(<Probe text={next} predict={predict} handle={handle} />);
      });
    };
    return { renderer, handle, type };
  }

  test('the heuristic sets the chip at once, the endpoint confirms after the delay', async () => {
    const requests: string[] = [];
    const predict: PredictFn = async (text) => {
      requests.push(text);
      return verdict('hold', 0.6);
    };
    const { renderer, type } = await mountProbe('', predict);
    expect(probeState(renderer)).toEqual({ route: 'ask', pending: false, locked: false, empty: true });

    await type('what did Sarah say?');
    expect(probeState(renderer)).toMatchObject({ route: 'ask', pending: true, empty: false });
    expect(requests).toEqual([]);

    await act(async () => {
      jest.advanceTimersByTime(ROUTE_CONFIRM_DELAY_MS - 1);
    });
    expect(requests).toEqual([]);
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    await flush();
    expect(requests).toEqual(['what did Sarah say?']);
    expect(probeState(renderer)).toMatchObject({ route: 'hold', pending: false });
  });

  test('a keystroke inside the delay restarts it, and a stale answer never lands', async () => {
    const answers: Array<(value: RouteVerdict) => void> = [];
    const requests: string[] = [];
    const predict: PredictFn = (text) =>
      new Promise((resolve) => {
        requests.push(text);
        answers.push(resolve);
      });
    const { renderer, type } = await mountProbe('', predict);
    await type('book the');
    await act(async () => {
      jest.advanceTimersByTime(200);
    });
    await type('book the dentist');
    await act(async () => {
      jest.advanceTimersByTime(200);
    });
    expect(requests).toEqual([]);
    await act(async () => {
      jest.advanceTimersByTime(50);
    });
    expect(requests).toEqual(['book the dentist']);

    // The user types again before the answer arrives.
    await type('book the dentist?');
    expect(probeState(renderer).route).toBe('ask');
    await act(async () => {
      answers[0](verdict('hold'));
    });
    await flush();
    expect(probeState(renderer)).toMatchObject({ route: 'ask', pending: true });
  });

  test('Tab flips and locks; the lock stops predictions until the field is blank', async () => {
    const requests: string[] = [];
    const predict: PredictFn = async (text) => {
      requests.push(text);
      return verdict('ask');
    };
    const { renderer, handle, type } = await mountProbe('', predict);
    await act(async () => {
      handle.current?.flip();
    });
    expect(probeState(renderer)).toMatchObject({ route: 'ask', locked: false });

    await type('book the dentist');
    expect(probeState(renderer)).toMatchObject({ route: 'hold', pending: true });
    await act(async () => {
      handle.current?.flip();
    });
    expect(probeState(renderer)).toMatchObject({ route: 'ask', locked: true, pending: false });
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(requests).toEqual([]);

    await type('book the dentist tomorrow');
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    await flush();
    expect(requests).toEqual([]);
    expect(probeState(renderer)).toMatchObject({ route: 'ask', locked: true });

    await type('');
    expect(probeState(renderer)).toEqual({ route: 'ask', pending: false, locked: false, empty: true });
    await type('what is the plan?');
    await act(async () => {
      jest.advanceTimersByTime(ROUTE_CONFIRM_DELAY_MS);
    });
    await flush();
    expect(requests).toEqual(['what is the plan?']);
  });

  test('a preset locks Hold before any text, and reset returns to Ask', async () => {
    const predict: PredictFn = async () => verdict('ask');
    const { renderer, handle, type } = await mountProbe('', predict);
    await act(async () => {
      handle.current?.preset('hold');
    });
    expect(probeState(renderer)).toMatchObject({ route: 'hold', locked: true, empty: true });
    await type('what is the plan?');
    await act(async () => {
      jest.advanceTimersByTime(ROUTE_CONFIRM_DELAY_MS);
    });
    await flush();
    expect(probeState(renderer)).toMatchObject({ route: 'hold', locked: true });
    await act(async () => {
      handle.current?.reset();
    });
    expect(probeState(renderer)).toMatchObject({ route: 'ask', locked: false, pending: false });
  });

  test('a failed confirm keeps the shown route and stops the pending state', async () => {
    const predict: PredictFn = async () => {
      throw new Error('offline');
    };
    const { renderer, type } = await mountProbe('', predict);
    await type('book the dentist');
    await act(async () => {
      jest.advanceTimersByTime(ROUTE_CONFIRM_DELAY_MS);
    });
    await flush();
    expect(probeState(renderer)).toMatchObject({ route: 'hold', pending: false });
  });
});

/* ------------------------------------------------------------------ */
/* The chip                                                            */
/* ------------------------------------------------------------------ */

describe('the route chip', () => {
  test('one word, the route color, a border when locked, dim when pending or blank', () => {
    const ask = renderToStaticMarkup(<RouteChip route="ask" />);
    expect(ask).toContain('>Ask<');
    expect(ask).toContain('--color-accent-soft');
    expect(ask).toContain('border-transparent');
    expect(ask).not.toContain('<svg');

    const hold = renderToStaticMarkup(<RouteChip route="hold" locked pending />);
    expect(hold).toContain('>Hold<');
    expect(hold).toContain('--color-accent-2-soft');
    expect(hold).toContain('border-[var(--color-accent-2)]');
    expect(hold).toContain('opacity-70');
    expect(hold).toContain('data-locked="true"');

    const blank = renderToStaticMarkup(<RouteChip route="ask" disabled />);
    expect(blank).toContain('opacity-55');
    expect(blank).toContain('aria-disabled="true"');
    expect(routeChipLabel('hold', false)).toBe('Route: Hold. Press Tab to change it.');
    expect(routeChipLabel('ask', true)).toBe('Route: Ask');
  });

  test('a click flips, unless the field is blank', async () => {
    let flips = 0;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<RouteChip route="ask" onFlip={() => flips++} />);
    });
    await act(async () => {
      renderer.root.findByType('button').props.onClick();
    });
    expect(flips).toBe(1);
    await act(async () => {
      renderer.update(<RouteChip route="ask" disabled onFlip={() => flips++} />);
    });
    await act(async () => {
      renderer.root.findByType('button').props.onClick();
    });
    expect(flips).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* Keys                                                                */
/* ------------------------------------------------------------------ */

describe('the bar keys', () => {
  const key = (
    key: string,
    mods: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }> = {},
  ) => ({
    key,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    ...mods,
  });

  test('Enter follows the chip, Cmd+Enter always sends to chat', () => {
    expect(barKeyAction(key('Enter'), { route: 'ask', empty: false })).toBe('send');
    expect(barKeyAction(key('Enter'), { route: 'hold', empty: false })).toBe('hold');
    expect(barKeyAction(key('Enter', { metaKey: true }), { route: 'hold', empty: false })).toBe('send');
    expect(barKeyAction(key('Enter', { ctrlKey: true }), { route: 'hold', empty: false })).toBe('send');
    expect(barKeyAction(key('Enter', { shiftKey: true }), { route: 'hold', empty: false })).toBeNull();
  });

  test('Tab flips, Shift+Tab and a blank field keep the browser meaning', () => {
    expect(barKeyAction(key('Tab'), { route: 'ask', empty: false })).toBe('flip');
    expect(barKeyAction(key('Tab', { shiftKey: true }), { route: 'ask', empty: false })).toBeNull();
    expect(barKeyAction(key('Tab'), { route: 'ask', empty: true })).toBeNull();
  });

  test('Escape clears a field with text and does nothing on a blank one', () => {
    expect(barKeyAction(key('Escape'), { route: 'ask', empty: false })).toBe('clear');
    expect(barKeyAction(key('Escape'), { route: 'ask', empty: true })).toBeNull();
    expect(barKeyAction(key('a'), { route: 'ask', empty: false })).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* The landing                                                         */
/* ------------------------------------------------------------------ */

const cards = (count: number): HoldCard[] =>
  [
    { id: 'w1', title: 'Book the dentist', shape: 'quick', horizon: { kind: 'now', by: NOW + 2 * DAY } },
    {
      id: 'w2',
      title: 'Renew the passport',
      shape: 'project',
      horizon: { kind: 'later', notBefore: NOW + 59 * DAY },
    },
    { id: 'w3', title: 'Groceries', shape: 'list', horizon: null },
  ].slice(0, count) as HoldCard[];

function landing(renderer: ReactTestRenderer): ReactTestInstance {
  return renderer.root.find((node) => node.type === 'div' && 'data-hold-landing' in node.props);
}

function cardNodes(renderer: ReactTestRenderer): ReactTestInstance[] {
  return renderer.root.findAll((node) => node.type === 'div' && 'data-hold-card' in node.props);
}

describe('the Hold landing', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('the pure helpers', () => {
    expect(holdTitleFromText('  \n book the dentist \n before the trip')).toBe('book the dentist');
    expect(holdTitleFromText('   ')).toBe('');
    expect(holdLeaveDuration(1)).toBe(HOLD_LEAVE_MS);
    expect(holdLeaveDuration(3)).toBe(HOLD_LEAVE_MS + 2 * HOLD_STAGGER_MS);
    const rect = (left: number, top: number, width: number, height: number) =>
      ({ left, top, width, height }) as DOMRect;
    expect(holdOffsetToward(rect(100, 500, 200, 40), rect(10, 80, 100, 20))).toEqual({ x: -140, y: -430 });
    expect(holdOffsetToward(rect(0, 0, 10, 10), rect(0, 0, 0, 0))).toBeNull();
    expect(holdOffsetToward(null, rect(0, 0, 10, 10))).toBeNull();
  });

  test('serif line, then the parsed card, then the move to the rail, then done', async () => {
    let done = 0;
    let renderer!: ReactTestRenderer;
    const mount = (rows: HoldCard[] | null) => (
      <HoldLanding text="book the dentist" cards={rows} nowMs={NOW} onDone={() => done++} />
    );
    await act(async () => {
      renderer = create(mount(null));
    });
    expect(landing(renderer).props['data-phase']).toBe('holding');
    let markup = JSON.stringify(renderer.toJSON());
    expect(markup).toContain('book the dentist');
    expect(markup).not.toContain('quick');

    // The answer arrives early. The serif line still holds its 200 ms.
    await act(async () => {
      jest.advanceTimersByTime(50);
      renderer.update(mount(cards(1)));
    });
    expect(landing(renderer).props['data-phase']).toBe('holding');
    await act(async () => {
      jest.advanceTimersByTime(HOLD_COLLAPSE_MS - 50);
    });
    expect(landing(renderer).props['data-phase']).toBe('card');
    markup = JSON.stringify(renderer.toJSON());
    expect(markup).toContain('Book the dentist');
    expect(markup).toContain('quick');
    expect(markup).toContain('By Saturday');
    expect(cardNodes(renderer)[0].props['data-leaving']).toBeUndefined();

    await act(async () => {
      jest.advanceTimersByTime(HOLD_CARD_MS);
    });
    expect(landing(renderer).props['data-phase']).toBe('leave');
    expect(cardNodes(renderer)[0].props['data-leaving']).toBe(true);
    expect(cardNodes(renderer)[0].props.className).toContain('opacity-0');
    expect(done).toBe(0);

    await act(async () => {
      jest.advanceTimersByTime(HOLD_LEAVE_MS - 1);
    });
    expect(done).toBe(0);
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(done).toBe(1);
  });

  test('a split shows one card per Work, 60 ms apart, and waits for the last one', async () => {
    let done = 0;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <HoldLanding text="three things: a, b, c" cards={cards(3)} nowMs={NOW} onDone={() => done++} />,
      );
    });
    expect(cardNodes(renderer)).toHaveLength(1);
    await act(async () => {
      jest.advanceTimersByTime(HOLD_COLLAPSE_MS);
    });
    const rows = cardNodes(renderer);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.props['data-hold-card'])).toEqual(['w1', 'w2', 'w3']);
    expect(rows.map((row) => row.props.style.transitionDelay)).toEqual(['0ms', '60ms', '120ms']);
    const markup = JSON.stringify(renderer.toJSON());
    expect(markup).toContain('project');
    expect(markup).toContain('Back on Nov 1');
    expect(markup).toContain('list');

    await act(async () => {
      jest.advanceTimersByTime(HOLD_CARD_MS + HOLD_LEAVE_MS + 2 * HOLD_STAGGER_MS - 1);
    });
    expect(done).toBe(0);
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(done).toBe(1);
  });

  test('with reduced movement the card stays in place until the bar clears', async () => {
    let done = 0;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <HoldLanding
          text="book the dentist"
          cards={cards(1)}
          nowMs={NOW}
          reduceMotion
          onDone={() => done++}
        />,
      );
    });
    // Beat one ends, then the effect schedules beats two and three.
    await act(async () => {
      jest.advanceTimersByTime(HOLD_COLLAPSE_MS);
    });
    await act(async () => {
      jest.advanceTimersByTime(HOLD_CARD_MS + 10);
    });
    expect(landing(renderer).props['data-phase']).toBe('card');
    await act(async () => {
      jest.advanceTimersByTime(HOLD_LEAVE_MS);
    });
    expect(done).toBe(1);
  });

  test('unmount before the answer fires nothing', async () => {
    let done = 0;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<HoldLanding text="x" cards={null} nowMs={NOW} onDone={() => done++} />);
    });
    await act(async () => {
      renderer.unmount();
      jest.advanceTimersByTime(5000);
    });
    expect(done).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Hold this                                                           */
/* ------------------------------------------------------------------ */

describe('Hold this on a reply', () => {
  test('one click keeps the reply, then the control reads Kept and a second click is a no-op', async () => {
    const calls: HoldInput[] = [];
    const kept: string[] = [];
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <HoldThisControl
          messageId="m1"
          conversationId="c1"
          userText="what should I do about the dog"
          replyText="Three steps."
          hold={async (input) => {
            calls.push(input);
            return { cards: cards(1), existing: false };
          }}
          onKept={(result) => kept.push(String(result.cards.length))}
        />,
      );
    });
    const button = () => renderer.root.findByType('button');
    expect(button().children.join('')).toBe(HOLD_THIS_LABEL);
    await act(async () => {
      button().props.onClick();
    });
    expect(button().children.join('')).toBe(HOLD_THIS_KEPT);
    expect(button().props.disabled).toBe(true);
    expect(calls).toEqual([
      {
        text: 'what should I do about the dog',
        replyText: 'Three steps.',
        conversationId: 'c1',
        sourceMessageId: 'm1',
      },
    ]);
    expect(kept).toEqual(['1']);

    await act(async () => {
      button().props.onClick();
    });
    expect(calls).toHaveLength(1);
  });

  test('a second click during the request is one request', async () => {
    let resolve!: (value: { cards: HoldCard[]; existing: boolean }) => void;
    let count = 0;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <HoldThisControl
          messageId="m1"
          conversationId="c1"
          userText=""
          replyText="Three steps."
          hold={() => {
            count++;
            return new Promise((r) => {
              resolve = r;
            });
          }}
        />,
      );
    });
    const button = () => renderer.root.findByType('button');
    await act(async () => {
      button().props.onClick();
      button().props.onClick();
    });
    expect(count).toBe(1);
    expect(button().props['data-state']).toBe('pending');
    await act(async () => {
      resolve({ cards: cards(1), existing: true });
    });
    expect(button().props['data-state']).toBe('kept');
  });

  test('a failure says so and lets the user try again', async () => {
    let attempts = 0;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <HoldThisControl
          messageId="m2"
          conversationId="c1"
          userText="x"
          replyText="y"
          hold={async () => {
            attempts++;
            if (attempts === 1) throw new Error(HOLD_ERROR);
            return { cards: cards(1), existing: false };
          }}
        />,
      );
    });
    const button = () => renderer.root.findByType('button');
    await act(async () => {
      button().props.onClick();
    });
    expect(JSON.stringify(renderer.toJSON())).toContain(HOLD_ERROR);
    expect(button().children.join('')).toBe(HOLD_THIS_LABEL);
    await act(async () => {
      button().props.onClick();
    });
    expect(button().children.join('')).toBe(HOLD_THIS_KEPT);
    expect(JSON.stringify(renderer.toJSON())).not.toContain(HOLD_ERROR);
  });
});

/* ------------------------------------------------------------------ */
/* The composer                                                        */
/* ------------------------------------------------------------------ */

interface Harness {
  renderer: ReactTestRenderer;
  value: () => string;
  sent: string[];
  held: string[];
  landed: number[];
  set: (value: string) => Promise<void>;
  openDoor: (seed: string | null) => Promise<void>;
  press: (
    key: string,
    mods?: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }>,
  ) => Promise<void>;
  chip: () => ReactTestInstance;
}

async function mountComposer(
  onHold: (text: string) => Promise<HoldCard[]> = async () => cards(1),
  predict: PredictFn = async () => verdict('ask'),
): Promise<Harness> {
  let value = '';
  let door: DoorRequest | null = null;
  const sent: string[] = [];
  const held: string[] = [];
  const landed: number[] = [];
  let renderer!: ReactTestRenderer;
  const element = () => (
    <AskHoldComposer
      value={value}
      onValueChange={(next) => {
        value = next;
        renderer.update(element());
      }}
      canSend={Boolean(value.trim())}
      onSend={() => {
        sent.push(value);
        value = '';
        renderer.update(element());
      }}
      onHold={(text) => {
        held.push(text);
        return onHold(text);
      }}
      onHeld={(rows) => landed.push(rows.length)}
      door={door}
      predict={predict}
      now={() => NOW}
      railTarget={() => null}
    />
  );
  await act(async () => {
    renderer = create(element());
  });
  const textarea = () => renderer.root.findByType('textarea');
  return {
    renderer,
    value: () => value,
    sent,
    held,
    landed,
    set: async (next) => {
      await act(async () => {
        textarea().props.onChange({ target: { value: next, style: {}, scrollHeight: 0 } });
      });
    },
    openDoor: async (seed) => {
      door = { seed, nonce: (door?.nonce ?? 0) + 1 };
      await act(async () => {
        renderer.update(element());
      });
    },
    press: async (key, mods = {}) => {
      await act(async () => {
        textarea().props.onKeyDown({
          key,
          shiftKey: false,
          metaKey: false,
          ctrlKey: false,
          preventDefault() {},
          ...mods,
        });
      });
    },
    chip: () => renderer.root.find((node) => node.type === 'button' && 'data-route' in node.props),
  };
}

describe('the composer', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('renders the placeholder, the chip, and the send control', async () => {
    const bar = await mountComposer();
    expect(bar.renderer.root.findByType('textarea').props.placeholder).toBe(BAR_PLACEHOLDER);
    expect(bar.chip().props['data-route']).toBe('ask');
    const send = bar.renderer.root.find(
      (node) => node.type === 'button' && node.props['aria-label'] === 'Send',
    );
    expect(send.props.disabled).toBe(true);
  });

  test('Enter on Ask sends to chat; Enter on Hold runs the landing; Cmd+Enter always sends', async () => {
    const bar = await mountComposer();
    await bar.set('what did Sarah say?');
    expect(bar.chip().props['data-route']).toBe('ask');
    await bar.press('Enter');
    expect(bar.sent).toEqual(['what did Sarah say?']);
    expect(bar.held).toEqual([]);

    await bar.set('book the dentist before the trip');
    expect(bar.chip().props['data-route']).toBe('hold');
    await bar.press('Enter', { metaKey: true });
    expect(bar.sent).toEqual(['what did Sarah say?', 'book the dentist before the trip']);
    expect(bar.held).toEqual([]);

    await bar.set('book the dentist before the trip');
    await bar.press('Enter');
    expect(bar.held).toEqual(['book the dentist before the trip']);
    expect(bar.value()).toBe('');
    const prompt = bar.renderer.root.find((node) => node.props['data-landing'] === 'true');
    expect(prompt).toBeDefined();
    expect(bar.renderer.root.findAllByType('textarea')).toHaveLength(0);
    expect(JSON.stringify(bar.renderer.toJSON())).toContain('book the dentist before the trip');

    await act(async () => {
      jest.advanceTimersByTime(HOLD_COLLAPSE_MS);
    });
    await act(async () => {
      jest.advanceTimersByTime(HOLD_CARD_MS + HOLD_LEAVE_MS);
    });
    expect(bar.landed).toEqual([1]);
    expect(bar.renderer.root.findAllByType('textarea')).toHaveLength(1);
    expect(bar.chip().props['data-route']).toBe('ask');
  });

  test('Tab flips and locks the chip; the send control follows it', async () => {
    const bar = await mountComposer();
    await bar.set('book the dentist');
    expect(bar.chip().props['data-route']).toBe('hold');
    await bar.press('Tab');
    expect(bar.chip().props['data-route']).toBe('ask');
    expect(bar.chip().props['data-locked']).toBe(true);
    const send = bar.renderer.root.find(
      (node) => node.type === 'button' && node.props['aria-label'] === 'Send',
    );
    expect(send.props.disabled).toBe(false);
    await bar.press('Tab');
    expect(bar.chip().props['data-route']).toBe('hold');
    expect(
      bar.renderer.root.find((node) => node.type === 'button' && node.props['aria-label'] === 'Hold'),
    ).toBeDefined();
    await bar.press('Enter');
    expect(bar.held).toEqual(['book the dentist']);
  });

  test('the sidebar door presets Hold and seeds the field', async () => {
    const bar = await mountComposer();
    await bar.openDoor(null);
    expect(bar.chip().props['data-route']).toBe('hold');
    expect(bar.chip().props['data-locked']).toBe(true);
    await bar.set('what is the plan?');
    await act(async () => {
      jest.advanceTimersByTime(ROUTE_CONFIRM_DELAY_MS);
    });
    await flush();
    expect(bar.chip().props['data-route']).toBe('hold');

    await bar.set('');
    await bar.openDoor('Reply to Sarah about the venue');
    expect(bar.value()).toBe('Reply to Sarah about the venue');
    expect(bar.chip().props['data-route']).toBe('hold');
    expect(bar.chip().props['data-locked']).toBe(true);
  });

  test('a failed Hold keeps the text, keeps Hold, and says so', async () => {
    const bar = await mountComposer(async () => {
      throw new Error(HOLD_ERROR);
    });
    await bar.set('book the dentist');
    await bar.press('Enter');
    await flush();
    expect(bar.value()).toBe('book the dentist');
    expect(bar.chip().props['data-route']).toBe('hold');
    expect(bar.chip().props['data-locked']).toBe(true);
    expect(JSON.stringify(bar.renderer.toJSON())).toContain(HOLD_ERROR);
    expect(bar.landed).toEqual([]);
  });

  test('Escape clears the field', async () => {
    const bar = await mountComposer();
    await bar.set('book the dentist');
    await bar.press('Escape');
    expect(bar.value()).toBe('');
  });
});
