import { afterEach, describe, expect, test } from 'bun:test';
import {
  prepareReleaseArrival,
  RELEASE_RECEIPT_KEY,
  type ReceiptStorage,
  readReleaseHistory,
  receiptForRelease,
  releaseHistoryStores,
  writeReleaseHistory,
} from '../lib/updates/receipt';
import { CURRENT_PRODUCT_RELEASE, newReleaseUpdates } from '../lib/updates/release';

function store() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}
const current = CURRENT_PRODUCT_RELEASE;
const before = { schemaVersion: 1 as const, id: 'previous-build', entryIds: [current.updates.at(-1)!.id] };
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

describe('Sprebuild-style release acknowledgements', () => {
  test('a first visit silently establishes a baseline in both stores', () => {
    const stores = [store(), store()];
    expect(prepareReleaseArrival(current, stores)).toBeNull();
    for (const storage of stores) expect(readReleaseHistory([storage])).toEqual(receiptForRelease(current));
  });

  test('an arrival on a different build keeps its notes pending across refreshes until dismissed', () => {
    const stores = [store(), store()];
    writeReleaseHistory(stores, before);
    expect(prepareReleaseArrival(current, stores)).toEqual(before);
    expect(prepareReleaseArrival(current, stores)).toEqual(before);
    expect(readReleaseHistory(stores)).toEqual(before);
    writeReleaseHistory(stores, receiptForRelease(current));
    expect(prepareReleaseArrival(current, stores)).toBeNull();
  });

  test('returning after several releases includes every new batch and excludes acknowledged notes', () => {
    const storage = store();
    writeReleaseHistory([storage], before);
    const previous = prepareReleaseArrival(current, [storage])!;
    expect(newReleaseUpdates(current, previous.entryIds).map((entry) => entry.id)).toEqual(
      current.updates.slice(0, -1).map((entry) => entry.id),
    );
  });

  test('an active tab keeps its own receipt when another tab acknowledges the release', () => {
    const firstTab = store();
    const secondTab = store();
    const persistent = store();
    writeReleaseHistory([firstTab, secondTab, persistent], before);
    writeReleaseHistory([secondTab, persistent], receiptForRelease(current));
    expect(prepareReleaseArrival(current, [firstTab, persistent])).toEqual(before);
    const newTab = store();
    expect(prepareReleaseArrival(current, [newTab, persistent])).toBeNull();
    expect(readReleaseHistory([newTab])).toEqual(receiptForRelease(current));
  });

  test('rollbacks show maintenance instead of replaying notes already known to the tab', () => {
    const storage = store();
    writeReleaseHistory([storage], { ...receiptForRelease(current), id: 'newer-build' });
    const previous = prepareReleaseArrival(current, [storage])!;
    expect(newReleaseUpdates(current, previous.entryIds)).toEqual([]);
  });

  test('an arrival from persistent history pins the pending notes to the new tab', () => {
    const tab = store();
    const persistent = store();
    writeReleaseHistory([persistent], before);
    expect(prepareReleaseArrival(current, [tab, persistent])).toEqual(before);
    expect(readReleaseHistory([tab])).toEqual(before);
    writeReleaseHistory([persistent], receiptForRelease(current));
    expect(prepareReleaseArrival(current, [tab, persistent])).toEqual(before);
    expect(readReleaseHistory([persistent])).toEqual(receiptForRelease(current));
  });

  test('a removed historical note does not hide new ones or break arrival', () => {
    const storage = store();
    writeReleaseHistory([storage], { ...before, entryIds: ['removed-note'] });
    const previous = prepareReleaseArrival(current, [storage])!;
    expect(newReleaseUpdates(current, previous.entryIds)).toEqual(current.updates);
  });

  test('readers of the former sidebar feed carry over only the notes they already saw', () => {
    const storage = store();
    storage.setItem('albatross:updates:last-seen', current.updates[1].id);
    const previous = prepareReleaseArrival(current, [store(), storage])!;
    expect(previous.id).toBe(`legacy:${current.updates[1].id}`);
    expect(newReleaseUpdates(current, previous.entryIds)).toEqual([current.updates[0]]);
    expect(readReleaseHistory([storage])).toBeNull();
    writeReleaseHistory([storage], receiptForRelease(current));
    expect(prepareReleaseArrival(current, [storage])).toBeNull();
  });

  test('an unknown legacy receipt establishes a fresh baseline', () => {
    const storage = store();
    storage.setItem('albatross:updates:last-seen', 'removed-note');
    expect(prepareReleaseArrival(current, [storage])).toBeNull();
  });

  test('malformed receipts fall back to the other store', () => {
    for (const value of [
      '{',
      'null',
      '{}',
      JSON.stringify({ ...before, schemaVersion: 2 }),
      JSON.stringify({ ...before, id: '' }),
      JSON.stringify({ ...before, entryIds: [42] }),
      JSON.stringify({ ...before, entryIds: ['same', 'same'] }),
    ]) {
      const tab = store();
      const persistent = store();
      tab.setItem(RELEASE_RECEIPT_KEY, value);
      writeReleaseHistory([persistent], before);
      expect(readReleaseHistory([tab, persistent])).toEqual(before);
    }
  });

  test('blocked reads and writes leave other stores and live checks usable', () => {
    const blocked: ReceiptStorage = {
      getItem() {
        throw new Error('Storage blocked');
      },
      setItem() {
        throw new Error('Storage blocked');
      },
    };
    expect(readReleaseHistory([blocked])).toBeNull();
    expect(prepareReleaseArrival(current, [blocked])).toBeNull();
    const working = store();
    writeReleaseHistory([blocked, working], before);
    expect(readReleaseHistory([blocked, working])).toEqual(before);
    expect(prepareReleaseArrival(current, [blocked, working])).toEqual(before);
    expect(prepareReleaseArrival(current, [])).toBeNull();
  });

  test('browser store discovery works with unavailable storage and during server rendering', () => {
    Reflect.deleteProperty(globalThis, 'window');
    expect(releaseHistoryStores()).toEqual([]);
    const persistent = store();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        get sessionStorage() {
          throw new Error('Session blocked');
        },
        localStorage: persistent,
      },
    });
    expect(releaseHistoryStores()).toEqual([persistent]);
    const tab = store();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { sessionStorage: tab, localStorage: persistent },
    });
    expect(releaseHistoryStores()).toEqual([tab, persistent]);
  });
});
