'use client';

import { useSyncExternalStore } from 'react';

export const UPDATES_SEEN_KEY = 'albatross:updates:last-seen';
const SEEN_EVENT = 'albatross:updates-seen';

export function readLastSeenUpdate(): string | null {
  try {
    return window.localStorage.getItem(UPDATES_SEEN_KEY);
  } catch {
    return null;
  }
}

export function markUpdatesSeen(id: string): void {
  try {
    window.localStorage.setItem(UPDATES_SEEN_KEY, id);
    window.dispatchEvent(new Event(SEEN_EVENT));
  } catch {
    // Browsers with storage disabled can still read every update.
  }
}

function subscribe(onChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === UPDATES_SEEN_KEY || event.key === null) onChange();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener(SEEN_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(SEEN_EVENT, onChange);
  };
}

export function useLastSeenUpdate() {
  return useSyncExternalStore(subscribe, readLastSeenUpdate, () => null);
}
