import { afterEach, describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createFileLibraryGet } from '../app/api/files/library/route';
import { AuthRequiredError } from '../lib/auth/current-user';
import { fileMatchesType, mergeFilePages, readFilePage } from '../lib/files/library-client';
import { searchFileLibrary } from '../lib/search/global-search';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const file = {
  id: 'a',
  name: 'Plan.pdf',
  provider: 'albatross' as const,
  isFolder: false,
  mimeType: 'application/pdf',
  webUrl: 'https://example.test/plan',
};

describe('file library boundaries', () => {
  test('uses the authenticated owner and never caches private listings', async () => {
    let args: unknown;
    const get = createFileLibraryGet({
      user: async () => ({ userId: 'owner' }),
      rate: async () => {},
      page: async (input: unknown) => {
        args = input;
        return { items: [file], nextCursor: 'next' };
      },
    } as any);
    const response = await get(
      new NextRequest('http://localhost/api/files/library?kind=uploads&userId=other&search=Plan&cursor=prev'),
    );
    expect(args).toEqual({ userId: 'owner', kind: 'uploads', search: 'Plan', cursor: 'prev' });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toMatchObject({ ok: true, nextCursor: 'next' });
  });
  test('rejects missing auth, invalid queries and masks backend failures', async () => {
    const defaults = {
      user: async () => ({ userId: 'owner' }),
      rate: async () => {},
      page: async () => {
        throw new Error('private backend detail');
      },
    };
    const get = createFileLibraryGet(defaults as any);
    expect((await get(new NextRequest('http://localhost/api/files/library?kind=unknown'))).status).toBe(400);
    expect(
      (
        await get(
          new NextRequest(`http://localhost/api/files/library?kind=uploads&search=${'x'.repeat(201)}`),
        )
      ).status,
    ).toBe(400);
    const failed = await get(new NextRequest('http://localhost/api/files/library?kind=documents'));
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain('private backend');
    const unauth = createFileLibraryGet({
      ...defaults,
      user: async () => {
        throw new AuthRequiredError('Sign in');
      },
    } as any);
    expect((await unauth(new NextRequest('http://localhost/api/files/library?kind=uploads'))).status).toBe(
      401,
    );
  });
  test('does not turn malformed successful responses into an empty folder', async () => {
    for (const body of [{}, { ok: true, items: null }, { ok: true, items: [{}] }]) {
      globalThis.fetch = (async () => Response.json(body)) as typeof fetch;
      await expect(readFilePage('/api/files/library')).rejects.toThrow('incomplete response');
    }
    const signal = new AbortController().signal;
    globalThis.fetch = (async (_input, init) => {
      expect(init?.signal).toBe(signal);
      expect(init?.cache).toBe('no-store');
      return Response.json({ ok: true, items: [file], nextCursor: 'more' });
    }) as typeof fetch;
    expect((await readFilePage('/api/files/library', signal)).nextCursor).toBe('more');
  });
  test('deduplicates pages by owner connection and filters by actual type', () => {
    const drive = { ...file, provider: 'google_drive' as const, connectionId: 'one' };
    expect(
      mergeFilePages([{ items: [file, drive] }, { items: [file, { ...drive, connectionId: 'two' }] }]),
    ).toHaveLength(3);
    expect(fileMatchesType(file, 'pdf')).toBe(true);
    expect(fileMatchesType(file, 'folders')).toBe(false);
    expect(fileMatchesType({ ...file, mimeType: 'application/x-albatross-spreadsheet' }, 'documents')).toBe(
      true,
    );
  });
  test('palette searches beyond empty pages, preserves ownership targets, and reports partial failures', async () => {
    const calls: string[] = [];
    const result = await searchFileLibrary('Plan', undefined, async (url) => {
      calls.push(url);
      const query = new URL(url, 'http://localhost').searchParams;
      if (query.get('kind') === 'uploads') throw new Error('offline');
      return query.has('cursor')
        ? { items: [{ ...file, documentId: 'doc' } as any] }
        : { items: [], nextCursor: 'older' };
    });
    expect(calls.some((url) => url.includes('cursor=older'))).toBe(true);
    expect(result.items[0].target).toEqual({ kind: 'document', documentId: 'doc' });
    expect(result.warnings).toHaveLength(1);
  });
  test('palette bounds scans and marks incompleteness, and respects cancellation', async () => {
    let calls = 0;
    const result = await searchFileLibrary('Plan', undefined, async () => {
      calls += 1;
      return { items: [], nextCursor: 'more' };
    });
    expect(calls).toBe(8);
    expect(result.warnings[0]).toContain('limited');
    const controller = new AbortController();
    controller.abort();
    await expect(searchFileLibrary('Plan', controller.signal)).rejects.toThrow();
  });
});
