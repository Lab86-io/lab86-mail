import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { convexTest } from 'convex-test';
import { NextRequest } from 'next/server';
import { createWebMetricsPost } from '../app/api/metrics/web/route';
import { createToolPost } from '../app/api/tools/[name]/route';
import { api, internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import schema from '../convex/schema';
import { AuthRequiredError } from '../lib/auth/current-user';
import { buildOpsReport, formatOpsReport, loadOpsReportData, type OpsReportData } from '../lib/ops/report';
import { createServerTiming } from '../lib/ops/server-timing';
import {
  emptySpeedBuckets,
  isRunSpeedName,
  isWebSpeedName,
  MAX_SPEED_ROWS_PER_WRITE,
  MAX_SPEED_VALUE,
  MAX_WEB_METRIC_EVENTS,
  MAX_WEB_METRICS_BYTES,
  mergeSpeedBuckets,
  runLatencySamples,
  SPEED_BUCKET_COUNT,
  speedBucketIndex,
  speedDay,
  speedDayBefore,
  speedPercentile,
  speedRollupOf,
} from '../lib/ops/speed';
import { createBeaconLimiter, createSpeedBuffer, SPEED_FLUSH_MS } from '../lib/ops/speed-buffer';
import {
  createWebSpeedReporter,
  formFactorOf,
  installWebSpeedListeners,
  MAX_SURFACE_MS,
  markSurfaceReady,
  openSurfaceVisit,
  SURFACE_INTENT_WINDOW_MS,
  sharedWebSpeedReporter,
  WEB_SPEED_FLUSH_MS,
  WEB_SPEED_URL,
  type WebSpeedReporterDeps,
  webSpeedBrowserDeps,
} from '../lib/ops/surface-timing';

const NOW = Date.UTC(2026, 10, 2, 14, 20);
const DAY = speedDay(NOW);
const SECRET = 'ops-speed-test-secret';
const KEY = { day: DAY, metric: 'LCP', surface: 'today', formFactor: 'desktop' };

describe('the histogram', () => {
  test('each value finds its bucket, and a huge value goes in the last one', () => {
    expect(speedBucketIndex(0)).toBe(0);
    expect(speedBucketIndex(25)).toBe(0);
    expect(speedBucketIndex(26)).toBe(1);
    expect(speedBucketIndex(MAX_SPEED_VALUE)).toBe(SPEED_BUCKET_COUNT - 1);
    expect(emptySpeedBuckets()).toHaveLength(SPEED_BUCKET_COUNT);
  });

  test('one sample is a row with a clamped value, and only the table fields', () => {
    const row = speedRollupOf({ ...KEY, value: 1_200 } as typeof KEY, 1_200);
    expect(row).toMatchObject({ ...KEY, count: 1, sum: 1_200 });
    expect(Object.keys(row).sort()).toEqual(
      ['buckets', 'count', 'day', 'formFactor', 'metric', 'sum', 'surface'].sort(),
    );
    expect(row.buckets.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(speedRollupOf(KEY, -5).sum).toBe(0);
    expect(speedRollupOf(KEY, MAX_SPEED_VALUE * 2).sum).toBe(MAX_SPEED_VALUE);
  });

  test('buckets merge, and a short row counts as zeros', () => {
    const merged = mergeSpeedBuckets(speedRollupOf(KEY, 10).buckets, [2]);
    expect(merged[0]).toBe(3);
    expect(merged).toHaveLength(SPEED_BUCKET_COUNT);
  });

  test('percentiles read from the buckets, and no data reads as null', () => {
    expect(speedPercentile(emptySpeedBuckets(), 0.5)).toBeNull();
    const buckets = emptySpeedBuckets();
    // Ten samples in the 1,000 to 1,500 bucket, and ten in the 2,000 to 2,500 one.
    buckets[speedBucketIndex(1_400)] = 10;
    buckets[speedBucketIndex(2_400)] = 10;
    expect(speedPercentile(buckets, 0.5)).toBe(1_500);
    expect(speedPercentile(buckets, 0.75)).toBe(2_250);
    const top = emptySpeedBuckets();
    top[SPEED_BUCKET_COUNT - 1] = 1;
    expect(speedPercentile(top, 0.5)).toBe(300_000);
    const first = emptySpeedBuckets();
    first[0] = 4;
    expect(speedPercentile(first, 0.5)).toBe(13);
  });

  test('names come from fixed lists', () => {
    expect(isWebSpeedName('LCP', 'today', 'desktop')).toBe(true);
    expect(isWebSpeedName('LCP', 'settings', 'desktop')).toBe(false);
    expect(isWebSpeedName('run_queue', 'run', 'server')).toBe(false);
    expect(isWebSpeedName('LCP', 'today', 'watch')).toBe(false);
    expect(isRunSpeedName('run_queue', 'run', 'server')).toBe(true);
    expect(isRunSpeedName('LCP', 'today', 'desktop')).toBe(false);
  });

  test('days are UTC', () => {
    expect(speedDay(NOW)).toBe('2026-11-02');
    expect(speedDayBefore(NOW, 7)).toBe('2026-10-26');
  });
});

describe('run latency', () => {
  const run = {
    createdAt: 1_000,
    startedAt: 1_300,
    finishedAt: 20_000,
    log: [{ at: 2_000 }, { at: 3_000 }, { at: 18_000 }],
    logLimit: 30,
  };
  const byMetric = (samples: ReturnType<typeof runLatencySamples>) =>
    Object.fromEntries(samples.map((sample) => [sample.metric, sample.value]));

  test('queue, first log line, and longest gap', () => {
    expect(byMetric(runLatencySamples(run))).toEqual({
      run_queue: 300,
      run_first_visible: 1_000,
      run_longest_silence: 15_000,
    });
  });

  test('firstVisibleAt from the runner wins over the first log line', () => {
    expect(byMetric(runLatencySamples({ ...run, firstVisibleAt: 1_500 })).run_first_visible).toBe(500);
    expect(byMetric(runLatencySamples({ ...run, firstVisibleAt: 'soon' })).run_first_visible).toBe(1_000);
  });

  test('a full log lost its first lines, so the time before them does not count', () => {
    const samples = byMetric(
      runLatencySamples({
        ...run,
        startedAt: 1_100,
        log: [{ at: 900_000 }, { at: 900_500 }],
        finishedAt: 901_000,
        logLimit: 2,
      }),
    );
    expect(samples.run_longest_silence).toBe(500);
    expect(samples.run_first_visible).toBeUndefined();
  });

  test('a run that never started has no queue time or silence', () => {
    const samples = runLatencySamples({ createdAt: 1, finishedAt: 2, log: [], logLimit: 30 });
    expect(samples).toEqual([]);
  });
});

describe('the server buffer', () => {
  function buffer(write = mock(async (_rows: unknown[]) => undefined)) {
    const timers: Array<{ run: () => void; ms: number }> = [];
    const errors: unknown[] = [];
    const speed = createSpeedBuffer({
      write,
      now: () => NOW,
      schedule: (run, ms) => timers.push({ run, ms }),
      onError: (error) => errors.push(error),
    });
    return { speed, write, timers, errors };
  }
  const sample = { metric: 'LCP', surface: 'today', formFactor: 'desktop', value: 1_000 };

  test('many samples from many users make one write, at most once a minute', async () => {
    const { speed, write, timers } = buffer();
    for (let index = 0; index < 500; index += 1) speed.add([sample]);
    expect(write).not.toHaveBeenCalled();
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(SPEED_FLUSH_MS);
    timers[0].run();
    await Promise.resolve();
    expect(write).toHaveBeenCalledTimes(1);
    const rows = write.mock.calls[0][0] as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ...KEY, count: 500, sum: 500_000 });
    expect(speed.pendingRows()).toBe(0);
  });

  test('an empty add and an empty flush do nothing', async () => {
    const { speed, write, timers } = buffer();
    speed.add([]);
    expect(timers).toEqual([]);
    expect(await speed.flush()).toBe(0);
    expect(write).not.toHaveBeenCalled();
  });

  test('a failed write keeps the sums for a later write', async () => {
    const write = mock(async (_rows: unknown[]) => undefined);
    write.mockRejectedValueOnce(new Error('Convex is down'));
    const { speed, timers, errors } = buffer(write);
    speed.add([sample]);
    await speed.flush();
    expect(errors).toHaveLength(1);
    expect(speed.pendingRows()).toBe(1);
    speed.add([sample]);
    timers.at(-1)?.run();
    await Promise.resolve();
    await Promise.resolve();
    const lastCall = write.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    expect((lastCall![0] as any[])[0].count).toBe(2);
  });

  test('more rows than one write can hold wait for the next one', async () => {
    const { speed, write, timers } = buffer();
    for (let index = 0; index < MAX_SPEED_ROWS_PER_WRITE + 3; index += 1)
      speed.add([{ ...sample, metric: `metric_${index}` }]);
    expect(await speed.flush()).toBe(MAX_SPEED_ROWS_PER_WRITE);
    expect(speed.pendingRows()).toBe(3);
    expect(timers.length).toBeGreaterThanOrEqual(1);
    expect((write.mock.calls[0][0] as unknown[]).length).toBe(MAX_SPEED_ROWS_PER_WRITE);
  });

  test('the limiter counts for each user and forgets the oldest user', () => {
    const allow = createBeaconLimiter({ limit: 2, windowMs: 1_000, maxUsers: 2 });
    expect(allow('a', 0)).toBe(true);
    expect(allow('a', 1)).toBe(true);
    expect(allow('a', 2)).toBe(false);
    expect(allow('b', 2)).toBe(true);
    expect(allow('a', 1_000)).toBe(true);
    expect(allow('c', 1_001)).toBe(true);
    expect(allow('b', 1_002)).toBe(true);
  });
});

describe('POST /api/metrics/web', () => {
  const event = { metric: 'LCP', surface: 'today', value: 1_200 };
  const body = (value: unknown = { formFactor: 'desktop', events: [event] }) => JSON.stringify(value);
  const request = (text: string, headers: Record<string, string> = {}) =>
    new NextRequest('https://mail.example.test/api/metrics/web', {
      method: 'POST',
      body: text,
      headers: { 'content-type': 'application/json', ...headers },
    });
  function route(overrides: Partial<Parameters<typeof createWebMetricsPost>[0]> = {}) {
    const add = mock((_samples: unknown[]) => undefined);
    const post = createWebMetricsPost({
      user: (async () => ({ userId: 'user_ops' })) as any,
      add: add as any,
      allow: () => true,
      now: () => NOW,
      ...overrides,
    });
    return { add, post };
  }

  test('takes a good batch, with the form factor on each sample and no user', async () => {
    const { add, post } = route();
    const response = await post(request(body()));
    expect(response.status).toBe(204);
    expect(add.mock.calls[0][0]).toEqual([{ ...event, formFactor: 'desktop' }]);
    expect(JSON.stringify(add.mock.calls[0][0])).not.toContain('user_ops');
  });

  test('a signed-out caller gets 401, and another auth error still throws', async () => {
    const out = route({
      user: (async () => {
        throw new AuthRequiredError('Sign in required');
      }) as any,
    });
    expect((await out.post(request(body()))).status).toBe(401);
    expect(out.add).not.toHaveBeenCalled();
    const broken = route({
      user: (async () => {
        throw new Error('Clerk is down');
      }) as any,
    });
    await expect(broken.post(request(body()))).rejects.toThrow('Clerk is down');
  });

  test.each([
    ['an unknown metric', { formFactor: 'desktop', events: [{ ...event, metric: 'FID' }] }],
    ['a server metric', { formFactor: 'desktop', events: [{ ...event, metric: 'run_queue' }] }],
    ['an unknown surface', { formFactor: 'desktop', events: [{ ...event, surface: 'settings' }] }],
    ['an unknown form factor', { formFactor: 'watch', events: [event] }],
    ['a field that could hold a URL', { formFactor: 'desktop', events: [{ ...event, url: '/x?id=1' }] }],
    ['an extra body field', { formFactor: 'desktop', events: [event], title: 'A thread' }],
    ['a negative value', { formFactor: 'desktop', events: [{ ...event, value: -1 }] }],
    ['a huge value', { formFactor: 'desktop', events: [{ ...event, value: MAX_SPEED_VALUE + 1 }] }],
    ['no events', { formFactor: 'desktop', events: [] }],
    [
      'too many events',
      { formFactor: 'desktop', events: Array.from({ length: MAX_WEB_METRIC_EVENTS + 1 }, () => event) },
    ],
  ])('rejects %s', async (_name, value) => {
    const { add, post } = route();
    expect((await post(request(body(value)))).status).toBe(400);
    expect(add).not.toHaveBeenCalled();
  });

  test('rejects text that is not JSON, and a body of another type', async () => {
    const { add, post } = route();
    expect((await post(request('{not json'))).status).toBe(400);
    expect((await post(request(body(), { 'content-type': 'text/plain' }))).status).toBe(415);
    expect(add).not.toHaveBeenCalled();
  });

  test('rejects a large body, by its header and by its real size', async () => {
    const { add, post } = route();
    const size = String(MAX_WEB_METRICS_BYTES + 1);
    expect((await post(request(body(), { 'content-length': size }))).status).toBe(413);
    expect((await post(request(' '.repeat(MAX_WEB_METRICS_BYTES + 1)))).status).toBe(413);
    expect(add).not.toHaveBeenCalled();
  });

  test('a full batch fits the body limit', () => {
    const events = Array.from({ length: MAX_WEB_METRIC_EVENTS }, () => ({
      metric: 'surface_switch',
      surface: 'needs_you',
      value: MAX_SPEED_VALUE,
    }));
    expect(JSON.stringify({ formFactor: 'desktop', events }).length).toBeLessThan(MAX_WEB_METRICS_BYTES);
  });

  test('too many batches get 429, with no Convex call for the limit', async () => {
    const { add, post } = route({ allow: () => false });
    expect((await post(request(body()))).status).toBe(429);
    expect(add).not.toHaveBeenCalled();
  });
});

describe('the browser reporter', () => {
  function reporter(overrides: Partial<WebSpeedReporterDeps> = {}) {
    const state = { now: 1_000, visible: true };
    const timers: Array<{ run: () => void; ms: number }> = [];
    const sent: any[] = [];
    const speed = createWebSpeedReporter({
      now: () => state.now,
      isVisible: () => state.visible,
      formFactor: () => 'desktop',
      send: (text) => sent.push(JSON.parse(text)),
      setTimer: (run, ms) => timers.push({ run, ms }),
      ...overrides,
    });
    return { speed, state, timers, sent };
  }

  test('the first surface counts from the navigation start, once', () => {
    const { speed, state, sent, timers } = reporter();
    speed.openVisit('today');
    state.now = 1_800;
    speed.markReady('today');
    speed.markReady('today');
    timers[0].run();
    expect(sent).toEqual([
      { formFactor: 'desktop', events: [{ metric: 'surface_load', surface: 'today', value: 1_800 }] },
    ]);
  });

  test('a switch counts from the click, and a stale click does not count', () => {
    const { speed, state, sent, timers } = reporter();
    speed.openVisit('today');
    speed.markReady('today');
    state.now = 5_000;
    speed.noteIntent();
    state.now = 5_100;
    speed.openVisit('mail');
    state.now = 5_400;
    speed.markReady('mail');
    state.now = 5_400 + SURFACE_INTENT_WINDOW_MS + 1;
    speed.openVisit('thread');
    state.now += 200;
    speed.markReady('thread');
    timers[0].run();
    expect(sent[0].events.slice(1)).toEqual([
      { metric: 'surface_switch', surface: 'mail', value: 400 },
      { metric: 'surface_switch', surface: 'thread', value: 200 },
    ]);
  });

  test('a surface that remounts is a new visit', () => {
    const { speed, state, sent, timers } = reporter();
    speed.markReady('thread');
    state.now += 100;
    speed.openVisit('thread');
    state.now += 50;
    speed.markReady('thread');
    timers[0].run();
    expect(sent[0].events).toHaveLength(2);
  });

  test('a hidden visit and a very long visit do not count', () => {
    const { speed, state, sent, timers } = reporter();
    speed.openVisit('mail');
    state.now += 100;
    speed.noteHidden();
    state.now += 100;
    speed.markReady('mail');
    speed.openVisit('today');
    state.now += MAX_SURFACE_MS + 1;
    speed.markReady('today');
    timers.at(-1)?.run();
    expect(sent).toEqual([]);
  });

  test('a page that loads hidden does not report its load', () => {
    const hidden = createWebSpeedReporter({
      now: () => 500,
      isVisible: () => false,
      formFactor: () => 'phone',
      send: () => {
        throw new Error('nothing to send');
      },
      setTimer: () => undefined,
    });
    hidden.openVisit('today');
    hidden.markReady('today');
  });

  test('vitals keep their names, and CLS scales', () => {
    const { speed, sent, timers } = reporter();
    speed.addVital('LCP', 1_234.4);
    speed.openVisit('mail');
    speed.addVital('CLS', 0.1234);
    speed.addVital('FID', 10);
    speed.addVital('Next.js-hydration', 10);
    speed.addVital('INP', Number.NaN);
    speed.addVital('TTFB', -1);
    timers[0].run();
    expect(sent[0].events).toEqual([
      { metric: 'LCP', surface: 'app', value: 1_234 },
      { metric: 'CLS', surface: 'mail', value: 123 },
    ]);
  });

  // Found in a real browser: LCP reports at the first input, after the switch.
  test('a load vital goes to the surface that loaded, and a page vital to the one on the screen', () => {
    const { speed, sent, timers } = reporter();
    speed.openVisit('today');
    speed.noteIntent();
    speed.openVisit('mail');
    speed.addVital('LCP', 900);
    speed.addVital('FCP', 300);
    speed.addVital('TTFB', 100);
    speed.addVital('INP', 16);
    timers[0].run();
    expect(sent[0].events.map((event: any) => [event.metric, event.surface])).toEqual([
      ['LCP', 'today'],
      ['FCP', 'today'],
      ['TTFB', 'today'],
      ['INP', 'mail'],
    ]);
  });

  test('sends at most one batch in 30 seconds', () => {
    const { speed, state, sent, timers } = reporter();
    speed.addVital('LCP', 1);
    speed.addVital('FCP', 1);
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(WEB_SPEED_FLUSH_MS);
    state.now += WEB_SPEED_FLUSH_MS;
    timers[0].run();
    expect(sent).toHaveLength(1);
    state.now += 1_000;
    speed.addVital('INP', 1);
    expect(timers[1].ms).toBe(WEB_SPEED_FLUSH_MS - 1_000);
    state.now += WEB_SPEED_FLUSH_MS;
    timers[1].run();
    expect(sent).toHaveLength(2);
  });

  test('sends what it holds when the page hides, and the 30 seconds still hold after it', () => {
    const { speed, state, sent, timers } = reporter();
    speed.addVital('LCP', 1);
    state.now += 5_000;
    speed.noteHidden();
    expect(sent).toHaveLength(1);
    state.visible = true;
    speed.addVital('FCP', 1);
    // The first timer fires too soon after the hide, so it waits again.
    timers[0].run();
    expect(sent).toHaveLength(1);
    expect(timers).toHaveLength(2);
    state.now += WEB_SPEED_FLUSH_MS;
    timers[1].run();
    expect(sent).toHaveLength(2);
  });

  test('a timer with nothing left to send stops', () => {
    const { speed, state, sent, timers } = reporter();
    speed.addVital('LCP', 1);
    speed.noteHidden();
    timers[0].run();
    expect(timers).toHaveLength(1);
    state.now += WEB_SPEED_FLUSH_MS;
    expect(sent).toHaveLength(1);
    speed.flush();
    expect(sent).toHaveLength(1);
  });

  test('a metric that arrives while the page is hidden goes out at once', () => {
    const { speed, state, sent, timers } = reporter();
    state.visible = false;
    speed.addVital('LCP', 1);
    expect(sent).toHaveLength(1);
    expect(timers).toEqual([]);
  });

  test('a long queue keeps the newest events', () => {
    const { speed, sent, timers } = reporter();
    for (let index = 0; index < MAX_WEB_METRIC_EVENTS + 5; index += 1) speed.addVital('LCP', index);
    timers[0].run();
    expect(sent[0].events).toHaveLength(MAX_WEB_METRIC_EVENTS);
    expect(sent[0].events[0].value).toBe(5);
  });

  test('form factors follow the width', () => {
    expect(formFactorOf(390)).toBe('phone');
    expect(formFactorOf(800)).toBe('tablet');
    expect(formFactorOf(1440)).toBe('desktop');
  });

  function fakeWindow(overrides: Record<string, unknown> = {}) {
    const fetched: Array<{ url: string; init: RequestInit }> = [];
    const beacons: Array<{ url: string; data: Blob }> = [];
    return {
      fetched,
      beacons,
      win: {
        innerWidth: 390,
        document: { visibilityState: 'visible' },
        navigator: {
          sendBeacon: (url: string, data: Blob) => {
            beacons.push({ url, data });
            return true;
          },
        },
        performance: { now: () => 42 },
        setTimeout: (run: () => void) => {
          run();
          return 1;
        },
        fetch: async (url: string, init: RequestInit) => {
          fetched.push({ url, init });
          return {};
        },
        ...overrides,
      },
    };
  }

  test('the browser side sends a JSON beacon', async () => {
    const { win, beacons, fetched } = fakeWindow();
    const deps = webSpeedBrowserDeps(win);
    expect(deps.now()).toBe(42);
    expect(deps.isVisible()).toBe(true);
    expect(deps.formFactor()).toBe('phone');
    let ran = false;
    deps.setTimer(() => {
      ran = true;
    }, 1);
    expect(ran).toBe(true);
    deps.send('{"a":1}');
    expect(beacons[0].url).toBe(WEB_SPEED_URL);
    expect(beacons[0].data.type).toStartWith('application/json');
    expect(await beacons[0].data.text()).toBe('{"a":1}');
    expect(fetched).toEqual([]);
  });

  test('with no beacon, or a refused one, it falls back to a keepalive fetch', () => {
    const none = fakeWindow({ navigator: {} });
    webSpeedBrowserDeps(none.win).send('{}');
    expect(none.fetched[0].url).toBe(WEB_SPEED_URL);
    expect(none.fetched[0].init).toMatchObject({ method: 'POST', keepalive: true, body: '{}' });
    const refused = fakeWindow({ navigator: { sendBeacon: () => false } });
    webSpeedBrowserDeps(refused.win).send('{}');
    expect(refused.fetched).toHaveLength(1);
    const broken = fakeWindow({
      navigator: {},
      fetch: async () => {
        throw new Error('offline');
      },
    });
    webSpeedBrowserDeps(broken.win).send('{}');
  });

  test('the listeners see input and hiding, and the cleanup removes them', () => {
    const target = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    const noted = { intent: 0, hidden: 0 };
    const stop = installWebSpeedListeners(
      { noteIntent: () => (noted.intent += 1), noteHidden: () => (noted.hidden += 1) },
      target,
      doc,
    );
    for (const type of ['click', 'keydown', 'popstate']) target.dispatchEvent(new Event(type));
    expect(noted.intent).toBe(3);
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(noted.hidden).toBe(0);
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    target.dispatchEvent(new Event('pagehide'));
    expect(noted.hidden).toBe(2);
    stop();
    target.dispatchEvent(new Event('click'));
    doc.dispatchEvent(new Event('visibilitychange'));
    target.dispatchEvent(new Event('pagehide'));
    expect(noted).toEqual({ intent: 3, hidden: 2 });
  });

  test('outside a production browser the helpers do nothing', () => {
    expect(sharedWebSpeedReporter()).toBeNull();
    openSurfaceVisit('today');
    markSurfaceReady('today');
  });

  test.each([
    ['components/report/DailyReport.tsx', "useSurfaceReady('today',"],
    ['components/albatross/AlbatrossesSurface.tsx', "useSurfaceReady('albatrosses',"],
    ['components/albatross/WorkThread.tsx', "useSurfaceReady('thread',"],
    ['components/inbox/Inbox.tsx', "useSurfaceReady('mail',"],
    ['components/needs-you/NeedsYouSurface.tsx', "useSurfaceReady('needs_you',"],
    ['components/shell/AppShell.tsx', '<WebSpeedReporter />'],
  ])('%s has its timing call', (file, call) => {
    expect(readFileSync(file, 'utf8')).toContain(call);
  });
});

describe('Server-Timing', () => {
  test('lists each stage, also for a stage that throws', async () => {
    let clock = 0;
    const timing = createServerTiming(() => clock);
    const answer = await timing.measure('auth', () => {
      clock += 12.34;
      return 'ok';
    });
    expect(answer).toBe('ok');
    await expect(
      timing.measure('handler', async () => {
        clock += 5;
        throw new Error('no');
      }),
    ).rejects.toThrow('no');
    expect(timing.header()).toBe('auth;dur=12.3, handler;dur=5.0');
    const headers = new Headers();
    expect(timing.apply({ headers }).headers.get('Server-Timing')).toBe(timing.header());
  });

  test('a request with no stage has no header', () => {
    const headers = new Headers();
    createServerTiming().apply({ headers });
    expect(headers.has('Server-Timing')).toBe(false);
  });

  const request = () =>
    new NextRequest('https://mail.example.test/api/tools/search_mail', {
      method: 'POST',
      body: JSON.stringify({ query: 'private words' }),
    });
  const params = { params: Promise.resolve({ name: 'search_mail' }) };
  const tool = { name: 'search_mail', mutating: false } as any;

  test('the tool route sends its three stages, with no tool name or args', async () => {
    const post = createToolPost({
      user: (async () => ({ userId: 'u' })) as any,
      rate: (async () => ({ ok: true })) as any,
      tool: (() => tool) as any,
      invoke: (async () => ({ rows: [] })) as any,
    });
    const response = await post(request(), params);
    expect(response.status).toBe(200);
    const header = response.headers.get('Server-Timing') ?? '';
    expect(header).toMatch(/^auth;dur=[\d.]+, rate_limit;dur=[\d.]+, handler;dur=[\d.]+$/);
    expect(header).not.toContain('search_mail');
    expect(header).not.toContain('private');
  });

  test('a failed tool call shows the stages that ran', async () => {
    const error = console.error;
    console.error = () => undefined;
    try {
      const post = createToolPost({
        user: (async () => ({ userId: 'u' })) as any,
        rate: (async () => ({ ok: true })) as any,
        tool: (() => tool) as any,
        invoke: (async () => {
          throw new Error('The tool broke');
        }) as any,
      });
      const response = await post(request(), params);
      expect(response.status).toBe(500);
      expect(response.headers.get('Server-Timing')).toMatch(/handler;dur=/);
      const out = createToolPost({
        user: (async () => {
          throw new AuthRequiredError('Sign in required');
        }) as any,
        rate: (async () => ({ ok: true })) as any,
        tool: (() => tool) as any,
        invoke: (async () => ({})) as any,
      });
      const signedOut = await out(request(), params);
      expect(signedOut.status).toBe(401);
      expect(signedOut.headers.get('Server-Timing')).toMatch(/^auth;dur=[\d.]+$/);
    } finally {
      console.error = error;
    }
  });
});

describe('speed rows in Convex', () => {
  let previousSecret: string | undefined;
  beforeAll(() => {
    previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
  });
  afterAll(() => {
    if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
    else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
  });
  const modules = {
    '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
    '../convex/speedRollups.ts': () => import('../convex/speedRollups'),
    '../convex/opsHealth.ts': () => import('../convex/opsHealth'),
    '../convex/dailyReports.ts': () => import('../convex/dailyReports'),
    '../convex/retention.ts': () => import('../convex/retention'),
    '../convex/mailOneTimeCodes.ts': () => import('../convex/mailOneTimeCodes'),
    '../convex/albatrossStepRuns.ts': () => import('../convex/albatrossStepRuns'),
    '../convex/albatrossBrowserSessions.ts': () => import('../convex/albatrossBrowserSessions'),
    '../convex/albatrossWorkV2.ts': () => import('../convex/albatrossWorkV2'),
    '../convex/albatrossIntents.ts': () => import('../convex/albatrossIntents'),
    '../convex/albatrossWork.ts': () => import('../convex/albatrossWork'),
    '../convex/albatrossNotifications.ts': () => import('../convex/albatrossNotifications'),
    '../convex/boards.ts': () => import('../convex/boards'),
    '../convex/mobile.ts': () => import('../convex/mobile'),
    '../convex/albatross.ts': () => import('../convex/albatross'),
  };
  const harness = () => convexTest(schema, modules);

  test('batches merge into one row for each key', async () => {
    const t = harness();
    const rows = [speedRollupOf(KEY, 1_000), speedRollupOf({ ...KEY, surface: 'mail' }, 2_000)];
    await t.mutation(api.speedRollups.addWebRollups, { internalSecret: SECRET, rows });
    await t.mutation(api.speedRollups.addWebRollups, { internalSecret: SECRET, rows: [rows[0]] });
    const page = await t.query(api.speedRollups.rollupsPage, { internalSecret: SECRET, sinceDay: DAY });
    expect(page.isDone).toBe(true);
    expect(page.rows).toHaveLength(2);
    expect(page.rows.find((row) => row.surface === 'today')).toMatchObject({ count: 2, sum: 2_000 });
    const later = await t.query(api.speedRollups.rollupsPage, {
      internalSecret: SECRET,
      sinceDay: '2026-11-03',
    });
    expect(later.rows).toEqual([]);
  });

  // Found in a real browser: the buffer sent a `value` field, so each flush failed.
  test('samples from the real buffer pass the real mutation', async () => {
    const t = harness();
    const errors: unknown[] = [];
    const speed = createSpeedBuffer({
      write: (rows) => t.mutation(api.speedRollups.addWebRollups, { internalSecret: SECRET, rows }),
      now: () => NOW,
      schedule: () => undefined,
      onError: (error) => errors.push(error),
    });
    speed.add([
      { metric: 'surface_load', surface: 'today', formFactor: 'desktop', value: 500 },
      { metric: 'surface_load', surface: 'today', formFactor: 'desktop', value: 700 },
      { metric: 'CLS', surface: 'mail', formFactor: 'phone', value: 0 },
    ]);
    expect(await speed.flush()).toBe(2);
    expect(errors).toEqual([]);
    const page = await t.query(api.speedRollups.rollupsPage, { internalSecret: SECRET, sinceDay: DAY });
    expect(page.rows.find((row) => row.metric === 'surface_load')).toMatchObject({ count: 2, sum: 1_200 });
    expect(page.rows.find((row) => row.metric === 'CLS')).toMatchObject({ count: 1, sum: 0 });
  });

  test('rejects an unknown name, a wrong shape, and too many rows, with nothing saved', async () => {
    const t = harness();
    const good = speedRollupOf(KEY, 1);
    const bad = async (rows: unknown[]) =>
      expect(
        t.mutation(api.speedRollups.addWebRollups, { internalSecret: SECRET, rows: rows as any }),
      ).rejects.toThrow();
    await bad([good, { ...good, metric: 'FID' }]);
    await bad([{ ...good, surface: 'settings' }]);
    await bad([{ ...good, metric: 'run_queue', surface: 'run', formFactor: 'server' }]);
    await bad([{ ...good, buckets: [1] }]);
    await bad(Array.from({ length: MAX_SPEED_ROWS_PER_WRITE + 1 }, () => good));
    const rows = await t.run((ctx) => ctx.db.query('speedRollups').collect());
    expect(rows).toEqual([]);
  });

  test('every function needs the internal secret', async () => {
    const t = harness();
    await expect(t.mutation(api.speedRollups.addWebRollups, { rows: [] })).rejects.toThrow();
    await expect(t.query(api.speedRollups.rollupsPage, { sinceDay: DAY })).rejects.toThrow();
  });

  async function startRun(t: ReturnType<typeof harness>) {
    const caller = { internalSecret: SECRET, userId: 'user_ops' };
    const workId = await t.run((ctx) =>
      ctx.db.insert('albatrossIntents', {
        userId: 'user_ops',
        rawText: 'A test plan',
        title: 'A test plan',
        source: 'text',
        status: 'ready',
        workState: 'active',
        agentState: 'idle',
        createdAt: 1,
        updatedAt: 1,
      } as any),
    );
    const { runId }: any = await t.mutation(api.albatrossStepRuns.enqueue, {
      ...caller,
      workId: String(workId),
      stepKey: 'step-1',
      stepIdentity: 'step:test',
      stepTitle: 'A test step',
      trigger: 'user',
    });
    const id = runId as Id<'albatrossStepRuns'>;
    const fence = { ...caller, id, token: 'token-1' };
    await t.mutation(api.albatrossStepRuns.claim, fence);
    return { id, fence };
  }

  test('a finished run writes its health and latency, and no user id', async () => {
    const t = harness();
    const { fence } = await startRun(t);
    await t.mutation(api.albatrossStepRuns.progress, { ...fence, line: 'Read the plan.' });
    await t.mutation(api.albatrossStepRuns.settle, { ...fence, outcome: 'done', summary: 'Finished.' });
    const health = await t.run((ctx) => ctx.db.query('opsHealthBuckets').collect());
    expect(health.map((row) => [row.kind, row.ok, row.failed])).toEqual([['run', 1, 0]]);
    const speed = await t.run((ctx) => ctx.db.query('speedRollups').collect());
    expect(speed.map((row) => row.metric).sort()).toEqual([
      'run_first_visible',
      'run_longest_silence',
      'run_queue',
    ]);
    expect(speed.every((row) => row.surface === 'run' && row.formFactor === 'server')).toBe(true);
    expect(JSON.stringify([health, speed])).not.toContain('user_ops');
    const page = await t.query(api.speedRollups.rollupsPage, {
      internalSecret: SECRET,
      sinceDay: speedDayBefore(Date.now(), 1),
    });
    expect(page.rows).toHaveLength(3);
  });

  test('a failed run counts as failed with its class, and a retry does not count yet', async () => {
    const t = harness();
    const { fence, id } = await startRun(t);
    await t.mutation(api.albatrossStepRuns.settle, { ...fence, error: 'fetch failed', retryable: true });
    expect(await t.run((ctx) => ctx.db.query('opsHealthBuckets').collect())).toEqual([]);
    await t.run(async (ctx) => {
      await ctx.db.patch(id, { availableAt: 0 });
    });
    await t.mutation(api.albatrossStepRuns.claim, { ...fence, token: 'token-2' });
    await t.mutation(api.albatrossStepRuns.settle, { ...fence, token: 'token-2', error: 'fetch failed' });
    const health = await t.run((ctx) => ctx.db.query('opsHealthBuckets').collect());
    expect(health).toHaveLength(1);
    expect(health[0]).toMatchObject({ kind: 'run', ok: 0, failed: 1, lastErrorClass: 'network' });
  });

  test('a lost run counts as failed once', async () => {
    const t = harness();
    const { id } = await startRun(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(id, { attempts: 2, availableAt: 0 });
      // The lease lives on its own small row. A lost run stopped renewing it.
      for (const live of await ctx.db.query('albatrossStepRunLive').collect())
        await ctx.db.patch(live._id, { leaseUntil: 0 });
    });
    await t.mutation(internal.albatrossStepRuns.expireLost, {});
    await t.mutation(internal.albatrossStepRuns.expireLost, {});
    const health = await t.run((ctx) => ctx.db.query('opsHealthBuckets').collect());
    expect(health.map((row) => [row.kind, row.failed])).toEqual([['run', 1]]);
  });

  test('a run that the user stopped does not count', async () => {
    const t = harness();
    const { id } = await startRun(t);
    await t.mutation(api.albatrossStepRuns.cancel, { internalSecret: SECRET, userId: 'user_ops', id });
    expect(await t.run((ctx) => ctx.db.query('opsHealthBuckets').collect())).toEqual([]);
  });

  test('the retention sweep removes old rows and keeps new ones', async () => {
    const t = harness();
    const old = '2026-01-01';
    const now = Date.now();
    const today = speedDay(now);
    await t.run(async (ctx) => {
      await ctx.db.insert('speedRollups', { ...speedRollupOf({ ...KEY, day: old }, 1), updatedAt: 0 });
      await ctx.db.insert('speedRollups', { ...speedRollupOf({ ...KEY, day: today }, 1), updatedAt: 0 });
      await ctx.db.insert('opsToolRollups', { day: old, toolName: 'a', errorClass: 'none', count: 1 });
      await ctx.db.insert('opsToolRollups', { day: today, toolName: 'a', errorClass: 'none', count: 1 });
      await ctx.db.insert('opsHealthBuckets', { hourStart: 0, kind: 'tool', shard: 0, ok: 1, failed: 0 });
      await ctx.db.insert('opsHealthBuckets', { hourStart: now, kind: 'tool', shard: 0, ok: 1, failed: 0 });
    });
    const { counts } = await t.mutation(internal.retention.sweep, {});
    expect(counts).toMatchObject({ speedRollups: 1, opsToolRollups: 1, opsHealthBuckets: 1 });
    const left = await t.run(async (ctx) => ({
      speed: await ctx.db.query('speedRollups').collect(),
      tools: await ctx.db.query('opsToolRollups').collect(),
      buckets: await ctx.db.query('opsHealthBuckets').collect(),
    }));
    expect(left.speed.map((row) => row.day)).toEqual([today]);
    expect(left.tools.map((row) => row.day)).toEqual([today]);
    expect(left.buckets.map((row) => row.hourStart)).toEqual([now]);
  });

  test('the report reads every page through queries, and writes nothing', async () => {
    const t = harness();
    const now = Date.now();
    await t.run(async (ctx) => {
      for (let shard = 0; shard < 3; shard += 1)
        await ctx.db.insert('opsHealthBuckets', {
          hourStart: now - 3_600_000,
          kind: 'model:jev',
          shard,
          ok: 1,
          failed: 3,
          lastErrorClass: 'auth',
        });
    });
    const calls: string[] = [];
    const data = await loadOpsReportData(
      (async (ref: any, args: any) => {
        calls.push(JSON.stringify(Object.keys(args)));
        return t.query(ref, { internalSecret: SECRET, ...args });
      }) as any,
      {
        buckets: api.opsHealth.bucketsPage,
        tools: api.opsHealth.toolRollupsPage,
        speed: api.speedRollups.rollupsPage,
        brief: api.dailyReports.editionTelemetrySummary,
      },
      now,
    );
    expect(data.buckets).toHaveLength(3);
    expect(data.buckets[0]).toEqual({
      hourStart: now - 3_600_000,
      kind: 'model:jev',
      ok: 1,
      failed: 3,
      lastErrorClass: 'auth',
    });
    expect(data.briefDay.editions).toBe(0);
    const text = formatOpsReport(buildOpsReport(data, now));
    expect(text).toContain('Jev model calls: 12 calls, 75.0% failed, last class auth');
  });
});

describe('the report', () => {
  const brief = {
    editions: 14,
    truncated: false,
    fallbackRate: 1 / 14,
    stages: {
      queued: { editions: 14, p50: 300, p90: 900 },
      prose: { editions: 14, p50: 20_000, p90: 42_000 },
    },
  };
  const speedRow = (metric: string, surface: string, formFactor: string, value: number, day = DAY) => ({
    ...speedRollupOf({ day, metric, surface, formFactor }, value),
  });
  const hour = Math.floor(NOW / 3_600_000) * 3_600_000;
  const data: OpsReportData = {
    buckets: [
      { hourStart: hour, kind: 'model:jev', ok: 24, failed: 76, lastErrorClass: 'auth' },
      { hourStart: hour - 3_600_000 * 72, kind: 'model:jev', ok: 100, failed: 0 },
      { hourStart: hour, kind: 'tool', ok: 1, failed: 1, lastErrorClass: 'unknown' },
    ],
    tools: [
      { day: DAY, toolName: 'document_create', errorClass: 'unknown', count: 12 },
      { day: DAY, toolName: 'document_create', errorClass: 'none', count: 3 },
      { day: DAY, toolName: 'send_mail', errorClass: 'rejected', count: 2 },
      { day: speedDayBefore(NOW, 3), toolName: 'old_tool', errorClass: 'none', count: 4 },
    ],
    speed: [
      speedRow('surface_load', 'today', 'desktop', 1_200),
      speedRow('surface_load', 'today', 'desktop', 1_400),
      speedRow('CLS', 'today', 'desktop', 120),
      speedRow('run_queue', 'run', 'server', 300),
      speedRow('run_longest_silence', 'run', 'server', 15_000),
      speedRow('LCP', 'mail', 'phone', 3_000, speedDayBefore(NOW, 3)),
    ],
    briefDay: brief,
    briefWeek: { ...brief, truncated: true },
  };
  const [day, week] = buildOpsReport(data, NOW);

  test('each window has its own rows', () => {
    expect(day.title).toBe('Last 24 hours');
    expect(week.title).toBe('Last 7 days');
    const jev = (window: typeof day) => window.groups.find((group) => group.kind === 'model:jev');
    expect(jev(day)).toMatchObject({ calls: 100, failed: 76, errorClass: 'auth' });
    expect(jev(week)?.calls).toBe(200);
    expect(day.tools.map((tool) => tool.toolName)).toEqual(['document_create', 'send_mail']);
    expect(week.tools.map((tool) => tool.toolName)).toContain('old_tool');
    expect(day.web.some((line) => line.surface === 'mail')).toBe(false);
    expect(week.web.some((line) => line.surface === 'mail')).toBe(true);
  });

  test('a rejected call and a success are not failures, and the worst tool comes first', () => {
    expect(day.tools[0]).toMatchObject({
      toolName: 'document_create',
      calls: 15,
      failed: 12,
      failureRate: 0.8,
    });
    expect(day.tools[0].classes).toEqual([{ errorClass: 'unknown', count: 12 }]);
    expect(day.tools[1]).toMatchObject({ toolName: 'send_mail', failed: 0, failureRate: 0 });
  });

  test('samples merge across days and go into percentiles', () => {
    const today = day.web.find((line) => line.metric === 'surface_load');
    expect(today).toMatchObject({ surface: 'today', formFactor: 'desktop', count: 2 });
    expect(today?.p50).toBeGreaterThan(1_000);
    expect(day.runs.map((line) => line.metric)).toEqual(['run_longest_silence', 'run_queue']);
  });

  test('the text has each section, and CLS prints its real value', () => {
    const text = formatOpsReport([day, week]);
    expect(text).toContain('== Last 24 hours ==');
    expect(text).toContain('== Last 7 days ==');
    expect(text).toContain('Jev model calls: 100 calls, 76.0% failed, last class auth');
    expect(text).toContain('document_create: 15 calls, 80.0% failed (unknown 12)');
    expect(text).toContain('queue: p50');
    expect(text).toContain('longest silence: p50');
    expect(text).toContain('14 editions, 7.1% fallback');
    expect(text).toContain('(newest 2,000 only)');
    expect(text).toContain('prose: p50 20.0 s, p90 42.0 s, 14 editions');
    expect(text).toMatch(/today CLS desktop: p50 0\.\d{3}/);
    expect(text).toContain('today surface_load desktop: p50');
  });

  test('empty rows print a plain line', () => {
    const empty = buildOpsReport(
      {
        buckets: [],
        tools: [],
        speed: [],
        briefDay: { ...brief, editions: 0, stages: {} },
        briefWeek: brief,
      },
      NOW,
    );
    const text = formatOpsReport(empty);
    expect(text).toContain('No tool calls.');
    expect(text).toContain('No finished runs.');
    expect(text).toContain('No web samples.');
    expect(text).toContain('Jev model calls: 0 calls, 0.0% failed');
  });
});
