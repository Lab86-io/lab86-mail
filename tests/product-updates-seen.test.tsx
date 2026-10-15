import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import {
  markUpdatesSeen,
  readLastSeenUpdate,
  UPDATES_SEEN_KEY,
  useLastSeenUpdate,
} from '../lib/updates/seen';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
let browser: EventTarget & { localStorage: Storage };
let renderer: ReactTestRenderer | undefined;
let observed: string | null;

function ReceiptProbe() {
  observed = useLastSeenUpdate();
  return null;
}

beforeEach(() => {
  const values = new Map<string, string>();
  browser = Object.assign(new EventTarget(), {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() {
        return values.size;
      },
    },
  });
  Object.defineProperty(globalThis, 'window', { value: browser, configurable: true });
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

describe('update receipts', () => {
  test('remembers a visit and notifies subscribers in this tab', async () => {
    await act(async () => {
      renderer = create(<ReceiptProbe />);
    });
    expect(observed!).toBeNull();
    await act(async () => markUpdatesSeen('newest'));
    expect(readLastSeenUpdate()).toBe('newest');
    expect(observed!).toBe('newest');
  });

  test('synchronizes across tabs and responds to cleared storage', async () => {
    markUpdatesSeen('older');
    await act(async () => {
      renderer = create(<ReceiptProbe />);
    });
    browser.localStorage.setItem(UPDATES_SEEN_KEY, 'newest');
    const event = Object.assign(new Event('storage'), { key: UPDATES_SEEN_KEY });
    await act(async () => {
      browser.dispatchEvent(event);
    });
    expect(observed!).toBe('newest');
    browser.localStorage.clear();
    await act(async () => {
      browser.dispatchEvent(Object.assign(new Event('storage'), { key: null }));
    });
    expect(observed!).toBeNull();
  });

  test('blocked storage never prevents reading updates', () => {
    Object.defineProperty(browser, 'localStorage', {
      get() {
        throw new Error('Storage disabled');
      },
    });
    expect(readLastSeenUpdate()).toBeNull();
    expect(() => markUpdatesSeen('newest')).not.toThrow();
  });
});
