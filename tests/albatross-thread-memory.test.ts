import { beforeEach, describe, expect, test } from 'bun:test';
import {
  hasThreadDraft,
  railScrollTop,
  resetThreadMemory,
  setRailScrollTop,
  setThreadDraft,
  setThreadScroll,
  subscribeThreadMemory,
  threadDraft,
  threadDraftWorkIds,
  threadMemoryVersion,
  threadScroll,
} from '../lib/albatross/thread-memory';
import { mainSidebarOpen } from '../lib/client-state';

// What a thread keeps while the user hops (docs/albatross-threads.md, T3):
// the draft, the scroll position, and the main sidebar's mode (lead decision 3).

describe('drafts and scroll per thread', () => {
  beforeEach(() => resetThreadMemory());

  test('a draft is kept per thread and reads back; an empty draft is not a draft', () => {
    expect(threadDraft('w1')).toBe('');
    setThreadDraft('w1', 'Use the Monday class');
    setThreadDraft('w2', '   ');
    expect(threadDraft('w1')).toBe('Use the Monday class');
    expect(hasThreadDraft('w1')).toBe(true);
    expect(hasThreadDraft('w2')).toBe(false);
    expect(threadDraft('w3')).toBe('');
  });

  test('listeners hear every change, and the version moves with them', () => {
    let heard = 0;
    const stop = subscribeThreadMemory(() => {
      heard += 1;
    });
    const before = threadMemoryVersion();
    setThreadDraft('w1', 'a');
    setThreadDraft('w1', 'a');
    setThreadDraft('w1', 'b');
    expect(heard).toBe(2);
    expect(threadMemoryVersion()).toBe(before + 2);
    stop();
    setThreadDraft('w1', 'c');
    expect(heard).toBe(2);
  });

  test('the scroll state is kept per thread', () => {
    expect(threadScroll('w1')).toBeNull();
    setThreadScroll('w1', { top: 420, atBottom: false });
    setThreadScroll('w2', { top: 0, atBottom: true });
    expect(threadScroll('w1')).toEqual({ top: 420, atBottom: false });
    expect(threadScroll('w2')?.atBottom).toBe(true);
  });

  test('drafts stay in memory only: nothing goes to browser storage', () => {
    const writes: string[] = [];
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { setItem: (key: string) => writes.push(key), getItem: () => null, removeItem: () => undefined },
    });
    try {
      setThreadDraft('w1', 'My passport number is X1234567');
      setThreadDraft('w2', 'Use the Monday class');
      setThreadDraft('w2', '');
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: original });
    }
    expect(writes).toEqual([]);
    expect([...threadDraftWorkIds()]).toEqual(['w1']);
  });

  test('the rail keeps its scroll position across hops, never below zero', () => {
    expect(railScrollTop()).toBe(0);
    setRailScrollTop(640);
    expect(railScrollTop()).toBe(640);
    setRailScrollTop(-20);
    expect(railScrollTop()).toBe(0);
  });
});

describe('the main sidebar while a thread is open', () => {
  test('closed stays closed; open stays open with no thread or on a wide window', () => {
    expect(mainSidebarOpen({ railOpen: false, threadOpen: true, wide: true, override: true })).toBe(false);
    expect(mainSidebarOpen({ railOpen: true, threadOpen: false, wide: false, override: false })).toBe(true);
    expect(mainSidebarOpen({ railOpen: true, threadOpen: true, wide: true, override: false })).toBe(true);
  });

  test('a thread on a narrower window drops the sidebar to icon mode unless the user opened it by hand', () => {
    expect(mainSidebarOpen({ railOpen: true, threadOpen: true, wide: false, override: false })).toBe(false);
    expect(mainSidebarOpen({ railOpen: true, threadOpen: true, wide: false, override: true })).toBe(true);
  });
});
