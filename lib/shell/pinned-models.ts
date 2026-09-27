import { useEffect, useSyncExternalStore } from 'react';

/**
 * Pinned models in the Settings model picker. The pins are kept for each user
 * on the server (/api/prefs `pinnedModels`), so they follow the account to
 * each device. Pins saved on this device before that are moved to the server
 * on the first load, then removed from device storage.
 */
export const PINNED_MODELS_KEY = 'lab86:pinned-models';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

function storage(): StorageLike | null {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

function modelIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

/** Pins that an earlier version kept only in device storage. */
export function readDevicePinnedModels(store: StorageLike | null = storage()): string[] {
  try {
    return modelIds(JSON.parse(store?.getItem(PINNED_MODELS_KEY) || '[]'));
  } catch {
    return [];
  }
}

export function togglePinnedModel(pins: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(pins);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export async function savePinnedModels(pins: ReadonlySet<string>, fetcher: Fetcher = fetch) {
  const response = await fetcher('/api/prefs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pinnedModels: [...pins].sort() }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) throw new Error(body?.error || 'The pins could not be saved.');
  return new Set(modelIds(body.prefs?.pinnedModels));
}

/**
 * The saved pins. Device pins from an earlier version are added to the
 * server list once; the device copy goes only after the server has them.
 */
export async function loadPinnedModels(
  fetcher: Fetcher = fetch,
  store: StorageLike | null = storage(),
): Promise<Set<string>> {
  const response = await fetcher('/api/prefs', { cache: 'no-store' });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) throw new Error(body?.error || 'The pins could not be loaded.');
  const saved = new Set(modelIds(body.prefs?.pinnedModels));
  const device = readDevicePinnedModels(store);
  if (!device.length) return saved;
  const merged = new Set([...saved, ...device]);
  const result = merged.size === saved.size ? saved : await savePinnedModels(merged, fetcher);
  try {
    store?.removeItem(PINNED_MODELS_KEY);
  } catch {
    // A blocked store sends the same pins again on the next load; the merge is idempotent.
  }
  return result;
}

// One shared copy for the page, so the two pickers in Settings agree.
const EMPTY: ReadonlySet<string> = new Set();
let pins: ReadonlySet<string> = EMPTY;
let loadState: 'idle' | 'loading' | 'loaded' = 'idle';
// Toggles made before the load finishes; they are applied to the loaded list.
let pending = new Map<string, boolean>();
let saves: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();

function publish(next: ReadonlySet<string>) {
  pins = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function queueSave(next: ReadonlySet<string>, previous: ReadonlySet<string>, fetcher: Fetcher) {
  // Saves go in order, so the server always ends with the newest list.
  saves = saves
    .then(() => savePinnedModels(next, fetcher))
    .catch(() => {
      if (pins === next) publish(previous);
    });
  return saves;
}

export function startPinnedModelsLoad(fetcher: Fetcher = fetch, store: StorageLike | null = storage()) {
  if (loadState !== 'idle') return;
  loadState = 'loading';
  void loadPinnedModels(fetcher, store)
    .then((loaded) => {
      const next = new Set(loaded);
      for (const [id, pinned] of pending) {
        if (pinned) next.add(id);
        else next.delete(id);
      }
      const changed = pending.size > 0;
      pending = new Map();
      loadState = 'loaded';
      publish(next);
      if (changed) void queueSave(next, loaded, fetcher);
    })
    .catch(() => {
      // Without the server list, the pins stay for this view only.
      loadState = 'idle';
    });
}

export function togglePin(id: string, fetcher: Fetcher = fetch) {
  const previous = pins;
  const next = togglePinnedModel(previous, id);
  publish(next);
  if (loadState === 'loaded') return queueSave(next, previous, fetcher);
  pending.set(id, next.has(id));
  return saves;
}

/** Test seam: forget the shared copy. */
export function resetPinnedModels() {
  pins = EMPTY;
  loadState = 'idle';
  pending = new Map();
  saves = Promise.resolve();
}

export function usePinnedModels() {
  const current = useSyncExternalStore(
    subscribe,
    () => pins,
    () => EMPTY,
  );
  useEffect(() => startPinnedModelsLoad(), []);
  return { pins: current, toggle: togglePin };
}
