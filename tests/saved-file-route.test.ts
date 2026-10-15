import { describe, expect, mock, test } from 'bun:test';
import { AuthRequiredError } from '../lib/auth/current-user';
import { SealedFileError } from '../lib/files/materialize';
import { createSavedFileGet, savedFileHeaders } from '../lib/files/saved-file-route';
import type { SavedFileRow } from '../lib/files/saved-files';
import { RateLimitError } from '../lib/rate-limit';

// Invented data only.
const user = { userId: 'u1', email: 'sam@example.com', name: 'Sam', source: 'clerk' as const };

function row(overrides: Partial<SavedFileRow> = {}): SavedFileRow {
  return {
    _id: 'upload_1',
    userId: 'u1',
    storageId: 's1',
    name: 'fw9.pdf',
    contentType: 'application/pdf',
    size: 3,
    createdAt: 1,
    url: 'https://storage.example.test/1',
    ...overrides,
  };
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    requireCurrentUser: async () => user,
    enforceUserRateLimit: async () => undefined,
    getFile: mock(async (): Promise<SavedFileRow | null> => row()),
    identityChecked: mock(async () => true),
    materialize: mock(async () => ({
      bytes: new Uint8Array([9, 9]),
      name: 'fw9 (filled).pdf',
      contentType: 'application/pdf',
      sealed: true,
    })),
    fetch: mock(async () => new Response(new Uint8Array([1, 2, 3]))),
    ...overrides,
  } as any;
}

const get = (d: any, query = '') =>
  createSavedFileGet(d)(new Request(`http://localhost/api/files/saved/upload_1${query}`), 'upload_1');

describe('GET /api/files/saved/[fileId]', () => {
  test('a plain file streams from storage as a download, or inline with ?preview=1', async () => {
    const d = deps();
    const res = await get(d);
    expect(res.status).toBe(200);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(res.headers.get('content-disposition')).toStartWith('attachment; filename="fw9.pdf"');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(d.getFile).toHaveBeenCalledWith('u1', 'upload_1');
    expect(d.identityChecked).not.toHaveBeenCalled();
    expect(d.materialize).not.toHaveBeenCalled();
    expect((d.fetch.mock.calls[0] as any[])[1]).toMatchObject({ redirect: 'error' });
    const inline = await get(deps(), '?preview=1');
    expect(inline.headers.get('content-disposition')).toStartWith('inline;');
    // Chromium's PDF viewer does not start in a sandbox.
    expect(inline.headers.get('content-security-policy')).toBeNull();
  });

  test('a sealed file needs the check, then fills in memory for a download', async () => {
    const sealed = row({ sealedFields: [{ field: 'tin', ref: '{{secure:si_x.number}}' }] });
    const unchecked = deps({ getFile: async () => sealed, identityChecked: async () => false });
    const refused = await get(unchecked);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ ok: false, code: 'verify_identity' });
    expect(unchecked.materialize).not.toHaveBeenCalled();
    const checked = deps({ getFile: async () => sealed });
    const res = await get(checked);
    expect(res.status).toBe(200);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([9, 9]);
    expect(res.headers.get('content-disposition')).toContain('fw9 (filled).pdf');
    expect(checked.materialize).toHaveBeenCalledWith('u1', 'upload_1', { kind: 'download', checked: true });
  });

  test('a sealed preview shows the stored file with no check and names its sealed fields', async () => {
    const sealed = row({ sealedFields: [{ field: 'tin', ref: '{{secure:si_x.number}}' }] });
    const d = deps({ getFile: async () => sealed, identityChecked: mock(async () => false) });
    const res = await get(d, '?preview=1');
    expect(res.status).toBe(200);
    // The stored bytes, never the filled ones: no check, no value opened.
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(d.identityChecked).not.toHaveBeenCalled();
    expect(d.materialize).not.toHaveBeenCalled();
    expect(JSON.parse(decodeURIComponent(res.headers.get('x-sealed-fields') || ''))).toEqual(['tin']);
    // The reference never leaves the server.
    expect(res.headers.get('x-sealed-fields')).not.toContain('secure');
    // A plain file has no sealed header.
    expect((await get(deps(), '?preview=1')).headers.get('x-sealed-fields')).toBeNull();
  });

  test('not found, gone from storage, store errors, rate limits, and no session', async () => {
    expect((await get(deps({ getFile: async () => null }))).status).toBe(404);
    expect((await get(deps({ getFile: async () => row({ url: null }) }))).status).toBe(404);
    expect((await get(deps({ fetch: async () => new Response('no', { status: 500 }) }))).status).toBe(502);
    const sealed = async () => row({ sealedFields: [{ field: 'tin', ref: '{{secure:si_x.number}}' }] });
    const gone = await get(
      deps({
        getFile: sealed,
        materialize: async () => {
          throw new SealedFileError(
            'gone',
            'A saved detail that this file uses is not in Passwords and IDs any more.',
          );
        },
      }),
    );
    expect(gone.status).toBe(409);
    expect(await gone.json()).toMatchObject({ code: 'gone' });
    const notFound = await get(
      deps({
        getFile: sealed,
        materialize: async () => {
          throw new SealedFileError('not_found', 'This file is not in Files any more.');
        },
      }),
    );
    expect(notFound.status).toBe(404);
    const needsCheck = await get(
      deps({
        getFile: sealed,
        materialize: async () => {
          throw new SealedFileError('verify_identity', 'Albatross needs one more check.');
        },
      }),
    );
    expect(needsCheck.status).toBe(403);
    const limited = await get(
      deps({
        enforceUserRateLimit: async () => {
          throw new RateLimitError('Too many requests.', 1_000, 60);
        },
      }),
    );
    expect(limited.status).toBe(429);
    const anonymous = await get(
      deps({
        requireCurrentUser: async () => {
          throw new AuthRequiredError('Sign in.');
        },
      }),
    );
    expect(anonymous.status).toBe(401);
    const errorSpy = mock(() => undefined);
    const original = console.error;
    console.error = errorSpy;
    try {
      const broken = await get(
        deps({
          getFile: async () => {
            throw new Error('Convex internal detail');
          },
        }),
      );
      expect(broken.status).toBe(500);
      expect(await broken.json()).toEqual({ ok: false, error: 'The file could not be read.' });
    } finally {
      console.error = original;
    }
  });

  test('headers: odd types download, names stay safe, and only PDF, PNG, and JPEG preview', () => {
    const html = savedFileHeaders({ contentType: 'text/html', name: 'x.html', preview: true });
    expect(html['content-disposition']).toStartWith('attachment;');
    expect(html['x-content-type-options']).toBe('nosniff');
    expect(savedFileHeaders({ contentType: 'bad type', name: 'a', preview: false })['content-type']).toBe(
      'application/octet-stream',
    );
    const named = savedFileHeaders({
      contentType: 'image/png',
      name: 'Ünïcode "quote".png',
      preview: true,
      size: 5,
    });
    expect(named['content-disposition']).toBe(
      `inline; filename="Unicode _quote_.png"; filename*=UTF-8''${encodeURIComponent('Ünïcode _quote_.png')}`,
    );
    expect(named['content-length']).toBe('5');
    expect(named['content-security-policy']).toContain('sandbox');
    expect(
      savedFileHeaders({ contentType: undefined, name: '', preview: false })['content-disposition'],
    ).toContain('filename="file"');
  });
});
