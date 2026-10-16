import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { GET } from '../app/api/app-release/route';
import {
  CURRENT_PRODUCT_RELEASE,
  fetchProductRelease,
  newReleaseUpdates,
  parseProductRelease,
} from '../lib/updates/release';

afterEach(() => {
  mockFetch?.mockRestore();
  mockFetch = undefined;
});
let mockFetch: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined;

describe('live product releases', () => {
  test('the endpoint returns the bundled release with no caching', async () => {
    const response = GET();
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.json()).toEqual(CURRENT_PRODUCT_RELEASE);
    expect(CURRENT_PRODUCT_RELEASE.id).toContain(CURRENT_PRODUCT_RELEASE.version);
  });

  test('only newly added notes appear when catching up, including after a rollback', () => {
    const current = structuredClone(CURRENT_PRODUCT_RELEASE);
    const next = {
      ...current,
      id: 'next',
      updates: [{ ...current.updates[0], id: 'a-new-note' }, ...current.updates],
    };
    expect(
      newReleaseUpdates(
        next,
        current.updates.map((note) => note.id),
      ).map((note) => note.id),
    ).toEqual(['a-new-note']);
    expect(
      newReleaseUpdates(
        current,
        next.updates.map((note) => note.id),
      ),
    ).toEqual([]);
  });

  test('validates release identity, schema, and note contents', () => {
    expect(parseProductRelease(CURRENT_PRODUCT_RELEASE)).toEqual(CURRENT_PRODUCT_RELEASE);
    for (const malformed of [
      {},
      { ...CURRENT_PRODUCT_RELEASE, id: '' },
      { ...CURRENT_PRODUCT_RELEASE, schemaVersion: 2 },
      { ...CURRENT_PRODUCT_RELEASE, updates: [{}] },
      {
        ...CURRENT_PRODUCT_RELEASE,
        updates: [...CURRENT_PRODUCT_RELEASE.updates, ...CURRENT_PRODUCT_RELEASE.updates],
      },
    ]) {
      expect(() => parseProductRelease(malformed)).toThrow();
    }
  });

  test('discovery uses the same origin, keeps session cookies, and bypasses cached releases', async () => {
    mockFetch = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(CURRENT_PRODUCT_RELEASE));
    const signal = new AbortController().signal;
    expect(await fetchProductRelease(signal)).toEqual(CURRENT_PRODUCT_RELEASE);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/app-release');
    expect(options?.cache).toBe('no-store');
    expect(options?.credentials).toBe('same-origin');
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  test('failed discovery leaves the current version alone', async () => {
    mockFetch = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Offline', { status: 503 }));
    await expect(fetchProductRelease()).rejects.toThrow('Could not check for updates.');
    mockFetch.mockResolvedValue(Response.json({ schemaVersion: 2 }));
    await expect(fetchProductRelease()).rejects.toThrow();
  });
});
