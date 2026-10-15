import { afterEach, describe, expect, test } from 'bun:test';
import {
  fetchSavedFile,
  fetchSavedFileOrCheck,
  isIdentityCheckBody,
  isSealedField,
  SavedFileError,
} from '../components/albatross/thread/PdfPane';

/* The PDF pane's rules (docs/research/goal-runs-web-design-2026-10-15.md,
 * §5.4): which widgets are sealed, and how the bytes route's identity check
 * comes back so Clerk's reverification can wrap it. */

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('sealed fields', () => {
  test('match by field name without case', () => {
    expect(isSealedField('ssn', ['SSN'])).toBe(true);
    expect(isSealedField('name', ['ssn'])).toBe(false);
    expect(isSealedField(null, ['ssn'])).toBe(false);
    expect(isSealedField('ssn', [])).toBe(false);
  });
});

describe('the identity check body', () => {
  test("the files builder's code or Clerk's reverification shape", () => {
    expect(isIdentityCheckBody({ code: 'verify_identity' })).toBe(true);
    expect(isIdentityCheckBody({ clerk_error: { type: 'forbidden', reason: 'reverification-error' } })).toBe(
      true,
    );
    expect(isIdentityCheckBody({ error: 'gone' })).toBe(false);
    expect(isIdentityCheckBody(null)).toBe(false);
  });
});

describe('the bytes', () => {
  test('come back as bytes, or as the check body on a 403, or throw', async () => {
    const bytes = new Uint8Array([37, 80, 68, 70]).buffer;
    globalThis.fetch = (async () => new Response(bytes, { status: 200 })) as unknown as typeof fetch;
    const ok = await fetchSavedFileOrCheck('/api/files/saved/upload_1?preview=1');
    expect('bytes' in ok && ok.bytes.byteLength).toBe(4);

    globalThis.fetch = (async () =>
      Response.json(
        { code: 'verify_identity', error: 'Verify your identity.' },
        { status: 403 },
      )) as unknown as typeof fetch;
    const check = await fetchSavedFileOrCheck('/api/files/saved/upload_1');
    expect('code' in check && check.code).toBe('verify_identity');
    await expect(fetchSavedFile('/api/files/saved/upload_1')).rejects.toMatchObject({
      code: 'verify_identity',
      status: 403,
    });

    globalThis.fetch = (async () =>
      Response.json({ error: 'Gone.' }, { status: 404 })) as unknown as typeof fetch;
    await expect(fetchSavedFileOrCheck('/api/files/saved/upload_2')).rejects.toBeInstanceOf(SavedFileError);
    await expect(fetchSavedFileOrCheck('/api/files/saved/upload_2')).rejects.toMatchObject({
      status: 404,
      message: 'Gone.',
    });
  });
});
