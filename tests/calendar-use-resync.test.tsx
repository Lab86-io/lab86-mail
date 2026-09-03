import { describe, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { CalendarSyncStateView } from '../lib/calendar/sync-copy';
import {
  type CalendarResyncHost,
  postCalendarResync,
  SYNC_SETTLE_CAP_MS,
  syncSettled,
  takeSyncBaseline,
  type UseCalendarResync,
  useCalendarResync,
  VIEW_OPEN_CLIENT_DEBOUNCE_MS,
} from '../lib/calendar/use-calendar-resync';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const T0 = 1_800_000_000_000;
const MIN = 60_000;

interface FakeHost extends CalendarResyncHost {
  requests: Array<{ url: string; body: any }>;
  responses: Array<{ status: number; body: any }>;
  timers: Map<number, { callback: () => void; delayMs: number }>;
  viewOpen: (() => void) | null;
  clock: number;
  fire(handle: number): void;
}

function fakeHost(): FakeHost {
  let nextTimer = 1;
  const host: FakeHost = {
    requests: [],
    responses: [],
    timers: new Map(),
    viewOpen: null,
    clock: T0,
    fetch: (async (url: string, init?: RequestInit) => {
      host.requests.push({ url, body: JSON.parse(String(init?.body || '{}')) });
      const next = host.responses.shift() || {
        status: 200,
        body: { ok: true, started: false, lastSyncedAt: null },
      };
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
    now: () => host.clock,
    setTimeout: (callback, delayMs) => {
      const handle = nextTimer++;
      host.timers.set(handle, { callback, delayMs });
      return handle;
    },
    clearTimeout: (handle) => {
      host.timers.delete(handle as number);
    },
    onViewOpen: (callback) => {
      host.viewOpen = callback;
      return () => {
        host.viewOpen = null;
      };
    },
    fire(handle) {
      const timer = host.timers.get(handle);
      host.timers.delete(handle);
      timer?.callback();
    },
  };
  return host;
}

let latest: UseCalendarResync | null = null;

function Probe(props: { states: CalendarSyncStateView[]; nowMs: number; host: FakeHost; enabled?: boolean }) {
  latest = useCalendarResync({
    syncStates: props.states,
    nowMs: props.nowMs,
    host: props.host,
    enabled: props.enabled,
  });
  return <span data-line={latest.line} data-active={latest.active} />;
}

async function mount(host: FakeHost, states: CalendarSyncStateView[], nowMs = T0, enabled = true) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<Probe states={states} nowMs={nowMs} host={host} enabled={enabled} />);
  });
  return {
    renderer,
    update: async (next: CalendarSyncStateView[], now = nowMs, on = enabled) => {
      await act(async () => renderer.update(<Probe states={next} nowMs={now} host={host} enabled={on} />));
    },
  };
}

const ready = (accountId: string, lastSyncedAt: number, extra: Partial<CalendarSyncStateView> = {}) => ({
  accountId,
  status: 'ready',
  lastSyncedAt,
  updatedAt: lastSyncedAt,
  ...extra,
});

describe('postCalendarResync', () => {
  test('maps the three outcomes', async () => {
    const host = fakeHost();
    host.responses.push({ status: 200, body: { ok: true, started: true, lastSyncedAt: T0 - MIN } });
    host.responses.push({ status: 429, body: { ok: false, retryAfterSeconds: 90 } });
    host.responses.push({ status: 500, body: { ok: false, error: 'boom' } });
    expect(await postCalendarResync(host.fetch, { reason: 'pull' })).toEqual({
      ok: true,
      started: true,
      lastSyncedAt: T0 - MIN,
    });
    expect(await postCalendarResync(host.fetch, { reason: 'pull' })).toEqual({
      ok: false,
      status: 429,
      retryAfterSeconds: 90,
    });
    expect(await postCalendarResync(host.fetch, { reason: 'pull' })).toEqual({
      ok: false,
      status: 500,
      message: 'boom',
    });
    expect(host.requests.map((r) => r.url)).toEqual([
      '/api/calendar/resync',
      '/api/calendar/resync',
      '/api/calendar/resync',
    ]);
  });

  test('a network failure is a status 0 failure', async () => {
    const failing = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await postCalendarResync(failing, { reason: 'manual_http' })).toEqual({
      ok: false,
      status: 0,
      message: 'offline',
    });
  });
});

describe('sync baseline', () => {
  test('settles when the oldest completed sync moves past the baseline', () => {
    const before = [ready('a', T0 - 5 * MIN), ready('b', T0 - 9 * MIN)];
    const baseline = takeSyncBaseline(before, T0 - 9 * MIN);
    expect(baseline.syncedAt).toBe(T0 - 9 * MIN);
    expect(syncSettled(before, baseline)).toBe(false);
    // One account done, the other not yet.
    expect(syncSettled([ready('a', T0), ready('b', T0 - 9 * MIN)], baseline)).toBe(false);
    expect(syncSettled([ready('a', T0), ready('b', T0 + 1)], baseline)).toBe(true);
  });

  test('a first sync settles when a completed sync appears', () => {
    const baseline = takeSyncBaseline([{ accountId: 'a', status: 'idle' }], null);
    expect(baseline.syncedAt).toBeNull();
    expect(syncSettled([{ accountId: 'a', status: 'syncing' }], baseline)).toBe(false);
    expect(syncSettled([ready('a', T0)], baseline)).toBe(true);
  });

  test('a new error settles the kick, an old error does not', () => {
    const oldError = { accountId: 'a', status: 'error', lastSyncedAt: T0 - 9 * MIN, updatedAt: T0 - MIN };
    const baseline = takeSyncBaseline([oldError], T0 - 9 * MIN);
    expect(syncSettled([oldError], baseline)).toBe(false);
    expect(syncSettled([{ ...oldError, updatedAt: T0 + 5_000 }], baseline)).toBe(true);
  });
});

describe('useCalendarResync', () => {
  test('posts view_open on mount, then nothing moves when the server says fresh', async () => {
    const host = fakeHost();
    host.responses.push({ status: 200, body: { ok: true, started: false, lastSyncedAt: T0 - 4 * MIN } });
    const states = [ready('a', T0 - 4 * MIN)];
    await mount(host, states);
    expect(host.requests).toEqual([{ url: '/api/calendar/resync', body: { reason: 'view_open' } }]);
    expect(latest?.active).toBe(false);
    expect(latest?.line).toBe('Synced 4 minutes ago');
  });

  test('view_open waits for the live data', async () => {
    const host = fakeHost();
    const { update } = await mount(host, [], T0, false);
    expect(host.requests).toHaveLength(0);
    await update([ready('a', T0 - 10 * MIN)], T0, true);
    expect(host.requests).toHaveLength(1);
  });

  test('a focus inside the client debounce is skipped, a later one posts', async () => {
    const host = fakeHost();
    const states = [ready('a', T0 - 10 * MIN)];
    await mount(host, states);
    expect(host.requests).toHaveLength(1);
    host.clock = T0 + VIEW_OPEN_CLIENT_DEBOUNCE_MS - 1;
    await act(async () => host.viewOpen?.());
    expect(host.requests).toHaveLength(1);
    host.clock = T0 + VIEW_OPEN_CLIENT_DEBOUNCE_MS;
    await act(async () => host.viewOpen?.());
    expect(host.requests).toHaveLength(2);
    expect(host.requests[1].body.reason).toBe('view_open');
  });

  test('a started kick shows the line until the live query settles', async () => {
    const host = fakeHost();
    host.responses.push({ status: 200, body: { ok: true, started: true, lastSyncedAt: T0 - 10 * MIN } });
    const states = [ready('a', T0 - 10 * MIN)];
    const { update } = await mount(host, states);
    expect(latest?.active).toBe(true);
    expect(latest?.line).toBe('Syncing');
    // The cap timer is armed.
    expect([...host.timers.values()].map((t) => t.delayMs)).toContain(SYNC_SETTLE_CAP_MS);
    // The live query catches up.
    await update([{ ...ready('a', T0 - 10 * MIN), status: 'syncing' }]);
    expect(latest?.active).toBe(true);
    await update([ready('a', T0 + 3_000)], T0 + 4_000);
    expect(latest?.active).toBe(false);
    expect(latest?.line).toBe('Synced just now');
  });

  test('the sentence posts manual_http and a 429 shows the retry copy until it expires', async () => {
    const host = fakeHost();
    host.responses.push({ status: 200, body: { ok: true, started: false, lastSyncedAt: T0 - 2 * MIN } });
    host.responses.push({ status: 429, body: { ok: false, retryAfterSeconds: 180 } });
    const states = [ready('a', T0 - 2 * MIN)];
    const { update } = await mount(host, states);
    await act(async () => latest?.resync('manual_http'));
    expect(host.requests[1].body).toEqual({ reason: 'manual_http' });
    expect(latest?.error).toEqual({ kind: 'limited', retryAt: T0 + 180_000 });
    expect(latest?.line).toBe('Too many syncs. Try again in 3 minutes.');
    await update(states, T0 + 2 * MIN);
    expect(latest?.line).toBe('Too many syncs. Try again in 1 minute.');
    await update(states, T0 + 3 * MIN);
    expect(latest?.error).toBeNull();
    expect(latest?.line).toBe('Synced 5 minutes ago');
  });

  test('a failed manual kick shows the failure sentence; a failed view_open stays quiet', async () => {
    const host = fakeHost();
    host.responses.push({ status: 500, body: { ok: false, error: 'down' } });
    host.responses.push({ status: 500, body: { ok: false, error: 'down' } });
    const states = [ready('a', T0 - 2 * MIN)];
    await mount(host, states);
    expect(latest?.error).toBeNull();
    expect(latest?.line).toBe('Synced 2 minutes ago');
    await act(async () => latest?.resync('pull'));
    expect(host.requests[1].body).toEqual({ reason: 'pull' });
    expect(latest?.error).toEqual({ kind: 'failed' });
    expect(latest?.line).toBe('Could not sync. Try again.');
  });

  test('the hold is capped: after 20 s the sentence shows the failure copy', async () => {
    const host = fakeHost();
    host.responses.push({ status: 200, body: { ok: true, started: true, lastSyncedAt: T0 - 10 * MIN } });
    await mount(host, [ready('a', T0 - 10 * MIN)]);
    expect(latest?.active).toBe(true);
    const cap = [...host.timers.entries()].find(([, t]) => t.delayMs === SYNC_SETTLE_CAP_MS);
    expect(cap).toBeDefined();
    await act(async () => host.fire(cap![0]));
    expect(latest?.active).toBe(false);
    expect(latest?.line).toBe('Could not sync. Try again.');
  });

  test('a server-started sync shows the line without a client kick', async () => {
    const host = fakeHost();
    const { update } = await mount(host, [ready('a', T0 - MIN)]);
    expect(latest?.active).toBe(false);
    await update([{ ...ready('a', T0 - MIN), status: 'syncing' }]);
    expect(latest?.active).toBe(true);
    expect(latest?.line).toBe('Syncing');
    await update([ready('a', T0 + 2_000)], T0 + 3_000);
    expect(latest?.active).toBe(false);
  });

  test('unmount unsubscribes from the view-open source', async () => {
    const host = fakeHost();
    const { renderer } = await mount(host, [ready('a', T0 - MIN)]);
    expect(host.viewOpen).not.toBeNull();
    await act(async () => renderer.unmount());
    expect(host.viewOpen).toBeNull();
  });
});
