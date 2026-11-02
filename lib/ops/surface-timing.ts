import {
  MAX_WEB_METRIC_EVENTS,
  type MarkedSurface,
  type WebFormFactor,
  type WebSpeedMetric,
  type WebSpeedSurface,
} from './speed';

// How fast each surface feels (docs/ops-signals.md). A visit starts at the
// page load, or at the click or key that changed the surface. It ends when the
// surface first shows real content, not a skeleton. The browser sends one small
// batch at most every 30 seconds, and when the page hides. A batch holds metric
// names, surface names, and numbers. It holds no URL, id, or title.

export const WEB_SPEED_URL = '/api/metrics/web';
export const WEB_SPEED_FLUSH_MS = 30_000;
/** A click older than this did not cause the surface change. */
export const SURFACE_INTENT_WINDOW_MS = 5_000;
/** A longer visit is a tab that waited for something else, so it does not count. */
export const MAX_SURFACE_MS = 120_000;
const VITALS: Partial<Record<string, WebSpeedMetric>> = {
  TTFB: 'TTFB',
  FCP: 'FCP',
  LCP: 'LCP',
  INP: 'INP',
  CLS: 'CLS',
};
/**
 * These measure the page load. The browser can report them after a surface
 * switch, so they go to the surface that loaded, not the surface on the screen.
 */
const LOAD_VITALS: ReadonlySet<WebSpeedMetric> = new Set(['TTFB', 'FCP', 'LCP']);

export interface WebSpeedEvent {
  metric: WebSpeedMetric;
  surface: WebSpeedSurface;
  value: number;
}

export interface WebSpeedReporterDeps {
  now: () => number;
  isVisible: () => boolean;
  formFactor: () => WebFormFactor;
  send: (body: string) => void;
  setTimer: (run: () => void, ms: number) => unknown;
}

interface Visit {
  surface: MarkedSurface;
  startedAt: number;
  load: boolean;
  done: boolean;
}

export function createWebSpeedReporter(deps: WebSpeedReporterDeps) {
  const visits = new Map<MarkedSurface, Visit>();
  let queue: WebSpeedEvent[] = [];
  let timer = false;
  let lastSentAt: number | null = null;
  let lastIntentAt: number | null = null;
  let lastHiddenAt: number | null = deps.isVisible() ? null : deps.now();
  let visited = false;
  let currentSurface: WebSpeedSurface = 'app';
  let loadSurface: WebSpeedSurface = 'app';

  function flush() {
    if (!queue.length) return;
    const events = queue;
    queue = [];
    lastSentAt = deps.now();
    deps.send(JSON.stringify({ formFactor: deps.formFactor(), events }));
  }

  function add(event: WebSpeedEvent) {
    queue.push(event);
    if (queue.length > MAX_WEB_METRIC_EVENTS) queue.shift();
    // The last vitals arrive while the page hides. No timer may run then.
    if (!deps.isVisible()) {
      flush();
      return;
    }
    armTimer();
  }

  function armTimer() {
    if (timer) return;
    timer = true;
    const wait = lastSentAt === null ? WEB_SPEED_FLUSH_MS : lastSentAt + WEB_SPEED_FLUSH_MS - deps.now();
    deps.setTimer(
      () => {
        timer = false;
        // A flush at page hide can come first. The limit of one batch in 30 seconds still holds.
        if (lastSentAt !== null && deps.now() - lastSentAt < WEB_SPEED_FLUSH_MS) {
          if (queue.length) armTimer();
          return;
        }
        flush();
      },
      Math.max(0, wait),
    );
  }

  function open(surface: MarkedSurface) {
    const now = deps.now();
    // The first surface of a page with no input before it counts from the
    // navigation start. All others count from the input that changed the surface.
    const load = !visited && lastIntentAt === null;
    const recentIntent =
      lastIntentAt !== null && now - lastIntentAt <= SURFACE_INTENT_WINDOW_MS ? lastIntentAt : null;
    const visit: Visit = { surface, startedAt: load ? 0 : (recentIntent ?? now), load, done: false };
    if (!visited) loadSurface = surface;
    visited = true;
    currentSurface = surface;
    visits.set(surface, visit);
    return visit;
  }

  return {
    openVisit: open,
    /** The first call of a visit counts. A later call does nothing. */
    markReady(surface: MarkedSurface) {
      const visit = visits.get(surface) ?? open(surface);
      if (visit.done) return;
      visit.done = true;
      const value = deps.now() - visit.startedAt;
      // A hidden tab has slow timers, so its visit says nothing about speed.
      if (lastHiddenAt !== null && lastHiddenAt >= visit.startedAt) return;
      if (value < 0 || value > MAX_SURFACE_MS) return;
      add({
        metric: visit.load ? 'surface_load' : 'surface_switch',
        surface,
        value: Math.round(value),
      });
    },
    addVital(name: string, value: number) {
      const metric = VITALS[name];
      if (!metric || !Number.isFinite(value) || value < 0) return;
      // CLS has no unit and is small. The rollup stores CLS × 1000.
      add({
        metric,
        surface: LOAD_VITALS.has(metric) ? loadSurface : currentSurface,
        value: Math.round(metric === 'CLS' ? value * 1000 : value),
      });
    },
    noteIntent() {
      lastIntentAt = deps.now();
    },
    noteHidden() {
      lastHiddenAt = deps.now();
      flush();
    },
    flush,
  };
}

export type WebSpeedReporter = ReturnType<typeof createWebSpeedReporter>;

export interface WebSpeedWindow {
  innerWidth: number;
  document: { visibilityState: string };
  navigator: { sendBeacon?: (url: string, data: Blob) => boolean };
  performance: { now: () => number };
  setTimeout: (run: () => void, ms: number) => unknown;
  fetch: (url: string, init: RequestInit) => Promise<unknown>;
}

export function formFactorOf(width: number): WebFormFactor {
  return width < 640 ? 'phone' : width < 1024 ? 'tablet' : 'desktop';
}

/** The browser side of the reporter. A failed beacon falls back to fetch; a lost batch is acceptable. */
export function webSpeedBrowserDeps(win: WebSpeedWindow): WebSpeedReporterDeps {
  return {
    now: () => win.performance.now(),
    isVisible: () => win.document.visibilityState === 'visible',
    formFactor: () => formFactorOf(win.innerWidth),
    setTimer: (run, ms) => win.setTimeout(run, ms),
    send: (body) => {
      const blob = new Blob([body], { type: 'application/json' });
      if (win.navigator.sendBeacon?.(WEB_SPEED_URL, blob)) return;
      void Promise.resolve(
        win.fetch(WEB_SPEED_URL, {
          method: 'POST',
          keepalive: true,
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body,
        }),
      ).catch(() => undefined);
    },
  };
}

/**
 * Listens for the input that starts a surface change and for the page hiding.
 * Returns the cleanup. The listeners are passive and read one clock each.
 */
export function installWebSpeedListeners(
  reporter: Pick<WebSpeedReporter, 'noteIntent' | 'noteHidden'>,
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
  doc: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> & { visibilityState: string },
) {
  const intent = () => reporter.noteIntent();
  const hide = () => reporter.noteHidden();
  const visibility = () => {
    if (doc.visibilityState === 'hidden') reporter.noteHidden();
  };
  const options = { capture: true, passive: true };
  for (const type of ['click', 'keydown', 'popstate']) target.addEventListener(type, intent, options);
  target.addEventListener('pagehide', hide, options);
  doc.addEventListener('visibilitychange', visibility, options);
  return () => {
    for (const type of ['click', 'keydown', 'popstate']) target.removeEventListener(type, intent, options);
    target.removeEventListener('pagehide', hide, options);
    doc.removeEventListener('visibilitychange', visibility, options);
  };
}

let shared: WebSpeedReporter | null = null;

/** The one reporter of this page. Null on the server, and in local development. */
export function sharedWebSpeedReporter(): WebSpeedReporter | null {
  if (typeof window === 'undefined' || process.env.NODE_ENV !== 'production') return null;
  shared ??= createWebSpeedReporter(webSpeedBrowserDeps(window as unknown as WebSpeedWindow));
  return shared;
}

/** Starts a new visit of a surface. useSurfaceReady calls this when the surface mounts. */
export function openSurfaceVisit(surface: MarkedSurface) {
  sharedWebSpeedReporter()?.openVisit(surface);
}

/**
 * Call this when a surface first shows real content. Other code can call it
 * freely: the first call of a visit counts, and a later call does nothing.
 */
export function markSurfaceReady(surface: MarkedSurface) {
  sharedWebSpeedReporter()?.markReady(surface);
}
