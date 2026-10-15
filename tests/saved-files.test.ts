import { afterEach, describe, expect, test } from 'bun:test';
import {
  __setSavedFilesDepsForTest,
  SAVED_FILE_MAX_BYTES,
  SavedFileError,
  savedFileName,
  savedFileOpenPath,
  saveFileBytes,
  sha256Hex,
} from '../lib/files/saved-files';

afterEach(() => __setSavedFilesDepsForTest());

function harness(options: { uploadOk?: boolean; storageId?: string | null } = {}) {
  const mutations: Array<{ args: Record<string, unknown> }> = [];
  const posts: Array<{ url: string; init: RequestInit }> = [];
  __setSavedFilesDepsForTest({
    convexMutation: (async (_fn: unknown, args: Record<string, unknown>) => {
      mutations.push({ args });
      return mutations.length === 1 ? 'https://upload.example/1' : 'upload_42';
    }) as any,
    fetch: async (url, init) => {
      posts.push({ url, init });
      if (options.uploadOk === false) return new Response('no', { status: 500 });
      const storageId = options.storageId === undefined ? 'storage_1' : options.storageId;
      return Response.json(storageId ? { storageId } : {});
    },
  });
  return { mutations, posts };
}

describe('saved files', () => {
  test('stores the bytes, registers the row with origin and hash, and returns the shared shape', async () => {
    const { mutations, posts } = harness();
    const bytes = new TextEncoder().encode('%PDF-1.7 test');
    const saved = await saveFileBytes({
      userId: 'u1',
      bytes,
      name: '../fw9.pdf',
      contentType: 'application/pdf',
      origin: 'web',
      sourceUrl: 'https://www.irs.gov/pub/irs-pdf/fw9.pdf',
      sealedFields: [{ field: 'tin', ref: '{{secure:item1.number}}' }],
      workId: 'w1',
    });
    expect(posts[0].url).toBe('https://upload.example/1');
    expect(posts[0].init.method).toBe('POST');
    expect(mutations[0].args).toEqual({ userId: 'u1' });
    expect(mutations[1].args).toEqual({
      userId: 'u1',
      storageId: 'storage_1',
      name: 'fw9.pdf',
      contentType: 'application/pdf',
      size: bytes.byteLength,
      origin: 'web',
      sha256: sha256Hex(bytes),
      sourceUrl: 'https://www.irs.gov/pub/irs-pdf/fw9.pdf',
      sealedFields: [{ field: 'tin', ref: '{{secure:item1.number}}' }],
      workId: 'w1',
    });
    expect(saved).toEqual({
      fileId: 'upload_42',
      title: 'fw9.pdf',
      openPath: '/?view=files&file=upload_42',
      size: bytes.byteLength,
      contentType: 'application/pdf',
      sha256: sha256Hex(bytes),
      sourceUrl: 'https://www.irs.gov/pub/irs-pdf/fw9.pdf',
    });
  });

  test('a file with no source, seal, or Work registers only the base fields', async () => {
    const { mutations } = harness();
    const saved = await saveFileBytes({
      userId: 'u1',
      bytes: new Uint8Array([1, 2, 3]),
      name: 'invoice.pdf',
      contentType: 'application/pdf',
      origin: 'export',
    });
    expect(Object.keys(mutations[1].args).sort()).toEqual(
      ['contentType', 'name', 'origin', 'sha256', 'size', 'storageId', 'userId'].sort(),
    );
    expect(saved.sourceUrl).toBeUndefined();
  });

  test('refuses empty and oversized files before any upload', async () => {
    const { posts } = harness();
    const base = { userId: 'u1', name: 'x.pdf', contentType: 'application/pdf', origin: 'filled' as const };
    await expect(saveFileBytes({ ...base, bytes: new Uint8Array() })).rejects.toThrow(SavedFileError);
    await expect(saveFileBytes({ ...base, bytes: new Uint8Array(SAVED_FILE_MAX_BYTES + 1) })).rejects.toThrow(
      'The file is larger than 25 MB.',
    );
    expect(posts).toHaveLength(0);
  });

  test('a failed upload or a missing storage id is an error', async () => {
    const base = {
      userId: 'u1',
      name: 'x.pdf',
      contentType: 'application/pdf',
      origin: 'web' as const,
      bytes: new Uint8Array([1]),
    };
    harness({ uploadOk: false });
    await expect(saveFileBytes(base)).rejects.toThrow('The file could not be stored.');
    harness({ storageId: null });
    await expect(saveFileBytes(base)).rejects.toThrow('Storage did not confirm this file.');
  });

  test('names lose path parts and control characters', () => {
    expect(savedFileName('C:\\temp\\a\u0001b.pdf')).toBe('ab.pdf');
    expect(savedFileName('   ')).toBe('file');
    expect(savedFileName('', 'download')).toBe('download');
    expect(savedFileName(`${'x'.repeat(200)}.pdf`)).toHaveLength(120);
    expect(savedFileOpenPath('a b')).toBe('/?view=files&file=a%20b');
  });
});
