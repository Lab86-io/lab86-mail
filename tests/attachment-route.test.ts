import { describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import {
  attachmentResponseHeaders,
  createAttachmentGet,
  isInlineSafeMime,
  normalizeAttachmentMime,
} from '../app/api/attachments/[messageId]/[attachmentId]/route';

const user = { userId: 'attach-user', email: 'me@example.test', name: 'Me', source: 'clerk' as const };
const params = { params: Promise.resolve({ messageId: 'm1', attachmentId: 'a1' }) };
const request = (query: string) =>
  new NextRequest(`http://localhost/api/attachments/m1/a1?account=me%40example.test&${query}`);
const emptyStream = () => new ReadableStream<Uint8Array>({ start: (c) => c.close() });
const deps = () => ({
  requireCurrentUser: mock(async () => user),
  openMailAttachment: mock(
    async (..._args: any[]): Promise<any> => ({ stream: emptyStream(), source: 'provider' }),
  ),
  defer: mock((_task: () => Promise<unknown>) => undefined),
});

describe('attachment route headers', () => {
  test('HTML and SVG previews download with nosniff and a sandbox', async () => {
    for (const mime of ['text/html', 'image/svg+xml', 'application/xhtml+xml', 'text/javascript']) {
      const res = await createAttachmentGet(deps())(
        request(`mime=${encodeURIComponent(mime)}&preview=1&name=x`),
        params,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toStartWith('attachment;');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-security-policy')).toContain('sandbox');
    }
  });

  test('safe types preview inline and keep the sandbox except for PDF', async () => {
    const image = attachmentResponseHeaders({ mime: 'image/png', filename: 'a.png', preview: true });
    expect(image['content-disposition']).toStartWith('inline;');
    expect(image['content-security-policy']).toContain('sandbox');
    const text = attachmentResponseHeaders({
      mime: 'TEXT/PLAIN; charset=latin1',
      filename: 'a.txt',
      preview: true,
    });
    expect(text['content-type']).toBe('text/plain; charset=utf-8');
    expect(text['content-disposition']).toStartWith('inline;');
    const pdf = attachmentResponseHeaders({ mime: 'application/pdf', filename: 'a"b.pdf', preview: true });
    expect(pdf['content-disposition']).toBe('inline; filename="ab.pdf"');
    expect(pdf['content-security-policy']).toBeUndefined();
    expect(pdf['x-content-type-options']).toBe('nosniff');
    const pdfDownload = attachmentResponseHeaders({
      mime: 'application/pdf',
      filename: 'a.pdf',
      preview: false,
    });
    expect(pdfDownload['content-disposition']).toStartWith('attachment;');
    expect(pdfDownload['content-security-policy']).toContain('sandbox');
  });

  test('mime normalization rejects malformed values', () => {
    expect(normalizeAttachmentMime('text/html\r\nx: y')).toBe('application/octet-stream');
    expect(normalizeAttachmentMime(undefined)).toBe('application/octet-stream');
    expect(normalizeAttachmentMime(' Video/MP4 ')).toBe('video/mp4');
    expect(isInlineSafeMime('audio/mpeg')).toBe(true);
    expect(isInlineSafeMime('image/svg+xml')).toBe(false);
  });

  test('missing inputs, missing grants, and provider errors', async () => {
    const d = deps();
    expect(
      (await createAttachmentGet(d)(new NextRequest('http://localhost/api/attachments/m1/a1'), params))
        .status,
    ).toBe(400);
    d.openMailAttachment.mockImplementation(async () => null);
    expect((await createAttachmentGet(d)(request('mime=image/png'), params)).status).toBe(404);
    d.openMailAttachment.mockImplementation(async () => {
      throw new Error('boom');
    });
    expect((await createAttachmentGet(d)(request('mime=image/png'), params)).status).toBe(502);
  });

  test('reads through the shared helper with lazy fill, as the signed-in user', async () => {
    const d = deps();
    const res = await createAttachmentGet(d)(
      request('mime=application/pdf&name=a%2Fb.pdf&preview=1'),
      params,
    );
    expect(res.status).toBe(200);
    const [ref, options] = d.openMailAttachment.mock.calls[0] as any[];
    expect(ref).toEqual({
      userId: 'attach-user',
      account: 'me@example.test',
      messageId: 'm1',
      attachmentId: 'a1',
    });
    expect(options.fill).toBe('always');
    expect(options.hint).toEqual({ filename: 'a_b.pdf', mimeType: 'application/pdf' });
    expect(options.defer).toBe(d.defer);
    expect(res.headers.get('content-disposition')).toBe('inline; filename="a_b.pdf"');
  });

  test('a stored file without query metadata uses the stored name and type, with the same guards', async () => {
    const d = deps();
    d.openMailAttachment.mockImplementation(async () => ({
      stream: new Response('<script>x</script>').body,
      source: 'store',
      filename: 'page.html',
      mimeType: 'text/html',
    }));
    const res = await createAttachmentGet(d)(
      new NextRequest('http://localhost/api/attachments/m1/a1?account=acct&preview=1'),
      params,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<script>x</script>');
    expect(res.headers.get('content-type')).toBe('text/html');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="page.html"');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const [, options] = d.openMailAttachment.mock.calls[0] as any[];
    expect(options.hint).toEqual({ filename: undefined, mimeType: undefined });
  });

  test('a stored file with no name falls back to "attachment"', async () => {
    const d = deps();
    const res = await createAttachmentGet(d)(
      new NextRequest('http://localhost/api/attachments/m1/a1?account=acct'),
      params,
    );
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="attachment"');
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
  });
});
