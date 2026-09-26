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
const deps = () => ({
  requireCurrentUser: mock(async () => user),
  downloadNylasAttachment: mock(async (): Promise<any> => new ReadableStream({ start: (c) => c.close() })),
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
    d.downloadNylasAttachment.mockImplementation(async () => null);
    expect((await createAttachmentGet(d)(request('mime=image/png'), params)).status).toBe(404);
    d.downloadNylasAttachment.mockImplementation(async () => {
      throw new Error('boom');
    });
    expect((await createAttachmentGet(d)(request('mime=image/png'), params)).status).toBe(502);
  });
});
