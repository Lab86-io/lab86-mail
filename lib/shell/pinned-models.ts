/**
 * Pinned models in the Settings model picker. The pins are a device
 * preference, kept in local storage so they survive a reload.
 */
export const PINNED_MODELS_KEY = 'lab86:pinned-models';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function storage(): StorageLike | null {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

export function readPinnedModels(store: StorageLike | null = storage()): Set<string> {
  try {
    const parsed = JSON.parse(store?.getItem(PINNED_MODELS_KEY) || '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

export function writePinnedModels(pins: Set<string>, store: StorageLike | null = storage()) {
  try {
    store?.setItem(PINNED_MODELS_KEY, JSON.stringify([...pins].sort()));
  } catch {
    // A full or blocked storage keeps the pins for this session only.
  }
}

export function togglePinnedModel(pins: Set<string>, id: string): Set<string> {
  const next = new Set(pins);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
