'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  anyAccountSyncing,
  type CalendarSyncError,
  type CalendarSyncStateView,
  oldestSyncedAt,
  syncStatusLine,
} from './sync-copy';

// The client side of `POST /api/calendar/resync`. One hook owns three
// things: the view-open kick (mount and window focus), the manual and pull
// kicks, and the state the SyncLine and the header sentence read.

export type CalendarResyncClientReason = 'view_open' | 'pull' | 'manual_http';

export type CalendarResyncResult =
  | { ok: true; started: boolean; lastSyncedAt: number | null }
  | { ok: false; status: 429; retryAfterSeconds: number }
  | { ok: false; status: number; message: string };

// A second view-open kick inside this window is skipped on the client. The
// server has its own two-minute rule; this one only stops a burst of focus
// events from posting in a row.
export const VIEW_OPEN_CLIENT_DEBOUNCE_MS = 30_000;

// The line must not hold at 70% for ever. After this the sentence shows the
// failure copy.
export const SYNC_SETTLE_CAP_MS = 20_000;

export async function postCalendarResync(
  fetchImpl: typeof fetch,
  body: { reason: CalendarResyncClientReason; accountId?: string },
): Promise<CalendarResyncResult> {
  let response: Response;
  try {
    response = await fetchImpl('/api/calendar/resync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error: any) {
    return { ok: false, status: 0, message: error?.message || 'Network error' };
  }
  let data: any = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (response.status === 429) {
    const seconds = Number(data?.retryAfterSeconds);
    return {
      ok: false,
      status: 429,
      retryAfterSeconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 60,
    };
  }
  if (!response.ok || data?.ok === false) {
    return {
      ok: false,
      status: response.status,
      message: data?.error || `Resync failed (${response.status})`,
    };
  }
  return {
    ok: true,
    started: Boolean(data?.started),
    lastSyncedAt: typeof data?.lastSyncedAt === 'number' ? data.lastSyncedAt : null,
  };
}

// The point a kick started from. The kick has settled when the oldest
// completed sync moves past this point, or when an account reports a new
// error. Both rules compare server times with server times, so a client
// clock that is off does not matter.
export interface SyncBaseline {
  syncedAt: number | null;
  errorMarks: Record<string, number>;
}

export function takeSyncBaseline(
  states: readonly CalendarSyncStateView[],
  responseSyncedAt: number | null,
): SyncBaseline {
  const errorMarks: Record<string, number> = {};
  for (const state of states) {
    if (state.status === 'error') errorMarks[state.accountId] = Number(state.updatedAt) || 0;
  }
  const live = oldestSyncedAt(states);
  const syncedAt =
    responseSyncedAt === null || live === null
      ? (responseSyncedAt ?? live)
      : Math.max(responseSyncedAt, live);
  return { syncedAt, errorMarks };
}

export function syncSettled(states: readonly CalendarSyncStateView[], baseline: SyncBaseline): boolean {
  for (const state of states) {
    if (state.status !== 'error') continue;
    const mark = baseline.errorMarks[state.accountId];
    if (mark === undefined || (Number(state.updatedAt) || 0) !== mark) return true;
  }
  const oldest = oldestSyncedAt(states);
  if (oldest === null) return false;
  return baseline.syncedAt === null || oldest > baseline.syncedAt;
}

export interface CalendarResyncHost {
  fetch: typeof fetch;
  now: () => number;
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  // Subscribe to "the view came back". Returns the unsubscribe function.
  onViewOpen: (callback: () => void) => () => void;
}

function browserHost(): CalendarResyncHost {
  return {
    fetch: (input, init) => globalThis.fetch(input, init),
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as any),
    onViewOpen: (callback) => {
      if (typeof window === 'undefined') return () => {};
      const onFocus = () => callback();
      const onVisibility = () => {
        if (document.visibilityState === 'visible') callback();
      };
      window.addEventListener('focus', onFocus);
      document.addEventListener('visibilitychange', onVisibility);
      return () => {
        window.removeEventListener('focus', onFocus);
        document.removeEventListener('visibilitychange', onVisibility);
      };
    },
  };
}

export interface UseCalendarResyncInput {
  syncStates: readonly CalendarSyncStateView[];
  nowMs: number;
  // False while the live data is not ready. The view-open kick waits.
  enabled?: boolean;
  host?: CalendarResyncHost;
}

export interface UseCalendarResync {
  // The header sentence.
  line: string;
  // True while a kicked or server-started sync runs. Drives the SyncLine.
  active: boolean;
  // True while a request is in flight.
  busy: boolean;
  error: CalendarSyncError | null;
  lastSyncedAt: number | null;
  resync: (reason: 'pull' | 'manual_http') => Promise<void>;
}

interface Kick {
  baseline: SyncBaseline;
  reason: CalendarResyncClientReason;
}

export function useCalendarResync({
  syncStates,
  nowMs,
  enabled = true,
  host,
}: UseCalendarResyncInput): UseCalendarResync {
  const hostRef = useRef<CalendarResyncHost | null>(host ?? null);
  if (!hostRef.current) hostRef.current = host ?? browserHost();
  const h = hostRef.current;

  const [kick, setKick] = useState<Kick | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CalendarSyncError | null>(null);
  const [responseSyncedAt, setResponseSyncedAt] = useState<number | null>(null);

  const statesRef = useRef(syncStates);
  statesRef.current = syncStates;
  const kickRef = useRef<Kick | null>(null);
  kickRef.current = kick;
  const busyRef = useRef(false);
  const lastViewOpenAt = useRef<number | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const post = useCallback(
    async (reason: CalendarResyncClientReason) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      if (reason !== 'view_open') setError(null);
      const result = await postCalendarResync(h.fetch, { reason });
      busyRef.current = false;
      if (!mounted.current) return;
      setBusy(false);
      if (result.ok) {
        setResponseSyncedAt(result.lastSyncedAt);
        if (result.started) {
          setError(null);
          setKick({ baseline: takeSyncBaseline(statesRef.current, result.lastSyncedAt), reason });
        }
        return;
      }
      if ('retryAfterSeconds' in result) {
        setError({ kind: 'limited', retryAt: h.now() + result.retryAfterSeconds * 1000 });
        return;
      }
      // A failed view-open kick stays quiet. The user did not ask for it.
      if (reason !== 'view_open') setError({ kind: 'failed' });
    },
    [h],
  );

  const viewOpen = useCallback(() => {
    const now = h.now();
    if (lastViewOpenAt.current !== null && now - lastViewOpenAt.current < VIEW_OPEN_CLIENT_DEBOUNCE_MS)
      return;
    if (kickRef.current || anyAccountSyncing(statesRef.current)) return;
    lastViewOpenAt.current = now;
    void post('view_open');
  }, [h, post]);

  // Mount and window focus.
  useEffect(() => {
    if (!enabled) return;
    viewOpen();
    return h.onViewOpen(viewOpen);
  }, [enabled, h, viewOpen]);

  // Settle the kick from the live query.
  const settled = kick !== null && syncSettled(syncStates, kick.baseline);
  useEffect(() => {
    if (settled) setKick(null);
  }, [settled]);

  // Cap the hold.
  useEffect(() => {
    if (!kick) return;
    const handle = h.setTimeout(() => {
      if (kickRef.current !== kick) return;
      setKick(null);
      setError({ kind: 'failed' });
    }, SYNC_SETTLE_CAP_MS);
    return () => h.clearTimeout(handle);
  }, [kick, h]);

  // A rate-limit sentence expires on its own.
  useEffect(() => {
    if (error?.kind === 'limited' && error.retryAt <= nowMs) setError(null);
  }, [error, nowMs]);

  const liveSyncedAt = oldestSyncedAt(syncStates);
  const lastSyncedAt = liveSyncedAt ?? responseSyncedAt;
  const active = kick !== null || anyAccountSyncing(syncStates);
  // A later completed sync clears a stale failure sentence.
  const failedStale = error?.kind === 'failed' && active;
  const shownError = failedStale ? null : error;

  const line = useMemo(
    () => syncStatusLine({ lastSyncedAt, nowMs, syncing: active, error: shownError }),
    [lastSyncedAt, nowMs, active, shownError],
  );

  const resync = useCallback((reason: 'pull' | 'manual_http') => post(reason), [post]);

  return { line, active, busy, error: shownError, lastSyncedAt, resync };
}
