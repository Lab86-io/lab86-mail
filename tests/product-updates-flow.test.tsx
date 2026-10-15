import { afterEach, describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Dialog } from '../components/ui/dialog';
import { ProductUpdateNotice } from '../components/updates/ProductUpdateNotice';
import { readReleaseHistory, receiptForRelease, writeReleaseHistory } from '../lib/updates/receipt';
import { CURRENT_PRODUCT_RELEASE } from '../lib/updates/release';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
let renderer: ReactTestRenderer | undefined;
let client: QueryClient;
function store() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}
function setup() {
  const session = store();
  const persistent = store();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: Object.assign(new EventTarget(), { sessionStorage: session, localStorage: persistent }),
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(['product-release'], CURRENT_PRODUCT_RELEASE);
  return [session, persistent];
}
function view(path: string) {
  return (
    <PathnameContext.Provider value={path}>
      <QueryClientProvider client={client}>
        <ProductUpdateNotice />
      </QueryClientProvider>
    </PathnameContext.Provider>
  );
}
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  client?.clear();
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

describe('the global update flow', () => {
  test('a first app visit quietly establishes its baseline', async () => {
    const stores = setup();
    await act(async () => {
      renderer = create(view('/updates'));
    });
    expect(renderer!.toJSON()).toBeNull();
    for (const storage of stores) {
      expect(readReleaseHistory([storage])).toEqual(receiptForRelease(CURRENT_PRODUCT_RELEASE));
    }
  });

  test('arrival opens new notes and acknowledges only when the installed dialog closes', async () => {
    const stores = setup();
    const previous = { schemaVersion: 1 as const, id: 'previous-build', entryIds: [] };
    writeReleaseHistory(stores, previous);
    await act(async () => {
      renderer = create(view('/updates'));
    });
    expect(renderer!.root.findByType(Dialog).props.open).toBe(true);
    expect(readReleaseHistory(stores)).toEqual(previous);
    await act(async () => {
      renderer!.update(view('/settings'));
    });
    expect(renderer!.root.findByType(Dialog).props.open).toBe(true);
    expect(readReleaseHistory(stores)).toEqual(previous);
    await act(async () => renderer!.root.findByType(Dialog).props.onOpenChange(false));
    expect(renderer!.toJSON()).toBeNull();
    expect(readReleaseHistory(stores)).toEqual(receiptForRelease(CURRENT_PRODUCT_RELEASE));
  });

  test('public, authentication, native and preview pages do not consume pending notes', async () => {
    const stores = setup();
    const previous = { schemaVersion: 1 as const, id: 'previous-build', entryIds: [] };
    writeReleaseHistory(stores, previous);
    for (const path of ['/privacy', '/sign-in', '/native/files', '/b/synthetic', '/dev/thread-preview']) {
      await act(async () => {
        if (renderer) renderer.update(view(path));
        else renderer = create(view(path));
      });
      expect(renderer!.toJSON()).toBeNull();
      expect(readReleaseHistory(stores)).toEqual(previous);
    }
    await act(async () => renderer!.update(view('/')));
    expect(renderer!.root.findByType(Dialog).props.open).toBe(true);
    expect(readReleaseHistory(stores)).toEqual(previous);
  });
});
