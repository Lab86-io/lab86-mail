import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { BrowserbaseRequestError } from '../lib/web/browserbase-client';
import {
  __setFilePullDepsForTest,
  ATTACHMENT_FILE_KINDS,
  detectWebFile,
  looksLikeHtml,
  pullWebFile,
  SAVE_FILE_KINDS,
  saveBrowserDownload,
  saveWebFile,
  sourceAddress,
  WEB_FILE_KINDS,
  WEB_FILE_MAX_BYTES,
  WebFileError,
  webFileName,
} from '../lib/web/file-pull';
import { DownloadError, type SessionPage } from '../lib/web/session';

afterEach(() => __setFilePullDepsForTest());

const PDF = new Uint8Array(Buffer.from('%PDF-1.7\n1 0 obj\n'));
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const HTML = new Uint8Array(Buffer.from('﻿  <!DOCTYPE html><html><body>Sign in</body></html>'));
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function office(part: string) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file(part, '<x/>');
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'STORE' }));
}

const raw = (bytes: Uint8Array, contentType: string, extra: Record<string, unknown> = {}) => ({
  statusCode: 200,
  headers: {},
  content: Buffer.from(bytes).toString('base64'),
  contentType,
  encoding: 'base64',
  ...extra,
});

describe('detectWebFile', () => {
  test('the first bytes decide the kind', async () => {
    expect(detectWebFile(PDF)).toBe('pdf');
    expect(detectWebFile(PNG, { contentType: 'image/png' })).toBe('png');
    expect(detectWebFile(JPEG, { contentType: 'image/jpg', name: 'photo.jpeg' })).toBe('jpeg');
    expect(detectWebFile(await office('word/document.xml'), { name: 'letter.docx' })).toBe('docx');
    expect(detectWebFile(await office('xl/workbook.xml'))).toBe('xlsx');
    expect(detectWebFile(await office('ppt/presentation.xml'))).toBe('pptx');
    expect(detectWebFile(new TextEncoder().encode('a,b\n1,2\n'), { contentType: 'text/csv' })).toBe('csv');
    expect(detectWebFile(new TextEncoder().encode('a,b'), { contentType: 'application/csv' })).toBe('csv');
    expect(
      detectWebFile(new TextEncoder().encode('a;b'), { contentType: 'text/plain', name: 'list.csv' }),
    ).toBe('csv');
  });

  test('plain text only where the caller allows it (mail and task attachments); never a zip', async () => {
    const text = new TextEncoder().encode('Line one\nLine two\n');
    expect(() => detectWebFile(text, { contentType: 'text/plain' })).toThrow(
      'This file type is not allowed. Allowed: PDF, Word (DOCX), Excel (XLSX), PowerPoint (PPTX), CSV, PNG, JPEG.',
    );
    expect(detectWebFile(text, { contentType: 'text/plain; charset=utf-8' }, ATTACHMENT_FILE_KINDS)).toBe(
      'txt',
    );
    expect(detectWebFile(text, { name: 'readme.txt' }, ATTACHMENT_FILE_KINDS)).toBe('txt');
    expect(() => detectWebFile(PDF, { contentType: 'text/plain' }, ATTACHMENT_FILE_KINDS)).toThrow(
      'The file says it is plain text, but its contents are PDF.',
    );
    const zip = new JSZip();
    zip.file('notes.txt', 'x');
    const zipped = new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
    expect(() => detectWebFile(zipped, {}, ATTACHMENT_FILE_KINDS)).toThrow(
      /not an Office file. Allowed: .*plain text/,
    );
    __setFilePullDepsForTest({
      fetchRaw: async () =>
        ({
          statusCode: 200,
          headers: {},
          content: 'hello',
          contentType: 'text/plain',
          encoding: 'utf-8',
        }) as any,
    });
    expect(await pullWebFile('https://a.test/notes', { kinds: ATTACHMENT_FILE_KINDS })).toMatchObject({
      kind: 'txt',
      name: 'notes.txt',
      contentType: 'text/plain',
    });
    await expect(pullWebFile('https://a.test/notes')).rejects.toThrow('This file type is not allowed.');
  });

  test('a page, a plain zip, another type, or a mismatch is refused with its code', async () => {
    const code = (bytes: Uint8Array, hints = {}) => {
      try {
        detectWebFile(bytes, hints);
        return 'ok';
      } catch (error) {
        return (error as WebFileError).code;
      }
    };
    expect(code(HTML)).toBe('page');
    expect(code(new TextEncoder().encode('<html><body>x</body></html>'))).toBe('page');
    const zip = new JSZip();
    zip.file('notes.txt', 'x');
    expect(code(new Uint8Array(await zip.generateAsync({ type: 'uint8array' })))).toBe('type');
    expect(code(new Uint8Array([0x47, 0x49, 0x46, 0x38]), { contentType: 'image/gif' })).toBe('type');
    expect(code(new TextEncoder().encode('plain words'))).toBe('type');
    expect(code(new Uint8Array([0x61, 0, 0x62]), { contentType: 'text/csv' })).toBe('type');
    expect(
      code(new Uint8Array([0xc3, 0x28, 0x61, 0x62, 0x63, 0x64, 0x65]), { contentType: 'text/csv' }),
    ).toBe('type');
    expect(code(PNG, { contentType: 'application/pdf' })).toBe('mismatch');
    expect(code(PDF, { name: 'form.docx' })).toBe('mismatch');
    expect(() => detectWebFile(PNG, { contentType: 'application/pdf' })).toThrow(
      'The file says it is PDF, but its contents are PNG.',
    );
    expect(looksLikeHtml(new TextEncoder().encode('<script>x</script>'))).toBe(true);
    expect(looksLikeHtml(PDF)).toBe(false);
  });

  test('names end with the kind extension; source addresses lose the fragment and, on request, the query', () => {
    expect(webFileName('Form W-9', 'pdf')).toBe('Form W-9.pdf');
    expect(webFileName('fw9.PDF', 'pdf')).toBe('fw9.PDF');
    expect(webFileName('photo.jpeg', 'jpeg')).toBe('photo.jpeg');
    expect(webFileName('report.bin', 'xlsx')).toBe('report.xlsx');
    expect(webFileName('', 'csv')).toBe('download.csv');
    expect(webFileName('.pdf', 'png')).toBe('download.png');
    expect(Object.keys(WEB_FILE_KINDS)).toEqual(['pdf', 'docx', 'xlsx', 'pptx', 'csv', 'png', 'jpeg', 'txt']);
    expect(SAVE_FILE_KINDS).toEqual(['pdf', 'docx', 'xlsx', 'pptx', 'csv', 'png', 'jpeg']);
    expect(ATTACHMENT_FILE_KINDS).toEqual([...SAVE_FILE_KINDS, 'txt']);
    expect(webFileName('notes', 'txt')).toBe('notes.txt');
    expect(sourceAddress('https://u:p@a.test/f.pdf?t=1#x')).toBe('https://a.test/f.pdf?t=1');
    expect(sourceAddress('https://a.test/f.pdf?token=secret', false)).toBe('https://a.test/f.pdf');
    expect(sourceAddress('nope')).toBe('');
  });
});

function fakePage(overrides: Partial<SessionPage> = {}): SessionPage {
  return {
    open: async () => ({ kind: 'page', url: 'https://a.test/', status: 200, contentType: 'text/html' }),
    title: async () => '',
    text: async () => '',
    fetchInPage: async () => ({ status: 200, contentType: 'text/html', url: 'https://a.test/', bytes: HTML }),
    requestWithHeaders: async () => {
      throw new Error('unused');
    },
    ...overrides,
  };
}

function sessionDeps(
  page: SessionPage,
  collected?: { bytes: Uint8Array; mimeType?: string; filename?: string },
  fetchRaw: () => Promise<any> = async () => {
    throw new BrowserbaseRequestError('Browserbase /fetch failed (502): too large', 502);
  },
) {
  const log: unknown[] = [];
  __setFilePullDepsForTest({
    fetchRaw,
    withShortSession: (async (input: any, task: any) => {
      log.push(['session', input]);
      return task(page, 'sess-1');
    }) as any,
    collectDownload: (async (sessionId: string, options: any) => {
      log.push(['collect', sessionId, options.filename]);
      if (!collected) throw new DownloadError('missing', 'The browser started no file download.');
      return {
        download: {
          id: 'd1',
          sessionId,
          filename: collected.filename ?? '',
          mimeType: collected.mimeType ?? '',
          size: collected.bytes.byteLength,
        },
        bytes: collected.bytes,
      };
    }) as any,
    deleteSessionDownloads: async (sessionId) => {
      log.push(['cleanup', sessionId]);
    },
    savedContextId: async (userId) => (userId === 'with-context' ? 'ctx-1' : null),
  });
  return log;
}

describe('pullWebFile', () => {
  test('tier 1: Fetch raw gives the file, with the name from the header or the address', async () => {
    const urls: string[] = [];
    __setFilePullDepsForTest({
      fetchRaw: async (url) => {
        urls.push(url);
        return raw(PDF, 'application/pdf', {
          headers: { 'content-disposition': `attachment; filename*=UTF-8''Form%20W-9.pdf` },
        }) as any;
      },
    });
    const file = await pullWebFile('https://www.irs.gov/pub/irs-pdf/fw9.pdf#page=2');
    expect(urls).toEqual(['https://www.irs.gov/pub/irs-pdf/fw9.pdf']);
    expect(file).toMatchObject({
      name: 'Form W-9.pdf',
      kind: 'pdf',
      contentType: 'application/pdf',
      size: PDF.byteLength,
      sha256: sha(PDF),
      sourceUrl: 'https://www.irs.gov/pub/irs-pdf/fw9.pdf',
      tier: 'fetch',
    });
    __setFilePullDepsForTest({
      fetchRaw: async () =>
        raw(PNG, 'image/png', { headers: { 'content-disposition': 'inline; filename="logo.png"' } }) as any,
    });
    expect((await pullWebFile('https://a.test/x', { name: 'Logo' })).name).toBe('Logo.png');
    __setFilePullDepsForTest({
      fetchRaw: async () =>
        ({
          statusCode: 200,
          headers: {},
          content: 'a,b\n1,2',
          contentType: 'text/csv',
          encoding: 'utf-8',
        }) as any,
    });
    expect((await pullWebFile('https://a.test/data.csv')).kind).toBe('csv');
  });

  test('refusals: bad and private addresses, 404, over 25 MB, wrong type, empty', async () => {
    const code = (promise: Promise<unknown>) =>
      promise.then(
        () => 'ok',
        (error) => (error as WebFileError).code,
      );
    expect(await code(pullWebFile('nope'))).toBe('bad_url');
    expect(await code(pullWebFile('http://169.254.169.254/latest'))).toBe('private_host');
    __setFilePullDepsForTest({
      fetchRaw: async () => raw(PDF, 'application/pdf', { statusCode: 404 }) as any,
    });
    expect(await code(pullWebFile('https://a.test/gone.pdf'))).toBe('not_found');
    __setFilePullDepsForTest({
      fetchRaw: async () =>
        raw(PDF, 'application/pdf', { headers: { 'content-length': String(WEB_FILE_MAX_BYTES + 1) } }) as any,
    });
    expect(await code(pullWebFile('https://a.test/huge.pdf'))).toBe('size');
    __setFilePullDepsForTest({
      fetchRaw: async () => raw(new Uint8Array([0x47, 0x49, 0x46]), 'image/gif') as any,
    });
    expect(await code(pullWebFile('https://a.test/a.gif'))).toBe('type');
    __setFilePullDepsForTest({ fetchRaw: async () => raw(new Uint8Array(), 'application/pdf') as any });
    expect(await code(pullWebFile('https://a.test/empty.pdf'))).toBe('failed');
    __setFilePullDepsForTest({
      fetchRaw: async () => {
        throw new BrowserbaseRequestError('Browserbase /fetch failed (400): bad', 400);
      },
    });
    await expect(pullWebFile('https://a.test/x.pdf')).rejects.toThrow('(400)');
  });

  test('tier 2: a 502 from Fetch opens one session; a download comes through the Downloads API', async () => {
    const log = sessionDeps(
      fakePage({
        open: async () => ({ kind: 'download', filename: 'fw9.pdf', url: 'https://a.test/fw9.pdf' }),
      }),
      { bytes: PDF, mimeType: 'application/pdf', filename: 'fw9.pdf' },
    );
    const file = await pullWebFile('https://a.test/fw9.pdf', { userId: 'no-context' });
    expect(file).toMatchObject({ tier: 'session', kind: 'pdf', name: 'fw9.pdf', sha256: sha(PDF) });
    expect(log).toEqual([
      ['session', { contextId: null, timeoutSeconds: 120, signal: undefined }],
      ['collect', 'sess-1', 'fw9.pdf'],
      ['cleanup', 'sess-1'],
    ]);
  });

  test('tier 3: a page with a sign-in wall uses the saved sign-ins, read only; the page file comes from the page', async () => {
    // The fetch tier saw a page; the session tier with the context reads the file in the page.
    const log = sessionDeps(
      fakePage({
        fetchInPage: async () => ({
          status: 200,
          contentType: 'image/png',
          url: 'https://a.test/p.png',
          bytes: PNG,
        }),
      }),
      undefined,
      async () => raw(HTML, 'text/html'),
    );
    const file = await pullWebFile('https://a.test/p.png', { userId: 'with-context' });
    expect(file).toMatchObject({ tier: 'signed_in', kind: 'png', name: 'p.png' });
    expect(log[0]).toEqual(['session', { contextId: 'ctx-1', timeoutSeconds: 120, signal: undefined }]);
  });

  test('session refusals: a page, a sign-in page, 404, a large file, no download', async () => {
    const code = (promise: Promise<unknown>) =>
      promise.then(
        () => 'ok',
        (error) => `${(error as WebFileError).code}: ${(error as Error).message}`,
      );
    sessionDeps(fakePage());
    expect(await code(pullWebFile('https://a.test/form'))).toBe(
      'page: The address opens a web page, not a file. Find the direct link to the file.',
    );
    sessionDeps(fakePage());
    expect(await code(pullWebFile('https://a.test/form', { userId: 'with-context' }))).toMatch(/^sign_in: /);
    sessionDeps(
      fakePage({
        open: async () => ({ kind: 'page', url: 'https://a.test/', status: 410, contentType: '' }),
      }),
    );
    expect(await code(pullWebFile('https://a.test/gone'))).toMatch(/^not_found: /);
    sessionDeps(
      fakePage({ fetchInPage: async () => ({ status: 200, contentType: '', url: '', tooLarge: true }) }),
    );
    expect(await code(pullWebFile('https://a.test/big'))).toBe('size: The file is larger than 25 MB.');
    sessionDeps(fakePage({ open: async () => ({ kind: 'download', filename: 'x.pdf', url: '' }) }));
    expect(await code(pullWebFile('https://a.test/x.pdf'))).toBe(
      'failed: The browser started no file download.',
    );
    sessionDeps(fakePage({ open: async () => ({ kind: 'download', filename: 'x.pdf', url: '' }) }));
    __setFilePullDepsForTest({
      fetchRaw: async () => raw(PDF, 'application/pdf', { statusCode: 403 }) as any,
      withShortSession: (async (_input: any, task: any) =>
        task(fakePage({ open: async () => ({ kind: 'download', filename: 'x', url: '' }) }), 's')) as any,
      collectDownload: async () => {
        throw new DownloadError('size', 'The file is larger than 25 MB.');
      },
      deleteSessionDownloads: async () => undefined,
    });
    expect(await code(pullWebFile('https://a.test/x.pdf'))).toBe('size: The file is larger than 25 MB.');
    __setFilePullDepsForTest({
      fetchRaw: async () => raw(PDF, 'application/pdf', { statusCode: 429 }) as any,
      withShortSession: (async () => {
        throw new Error('session down');
      }) as any,
    });
    await expect(pullWebFile('https://a.test/x.pdf')).rejects.toThrow('session down');
  });
});

describe('saveWebFile and saveBrowserDownload', () => {
  function saving() {
    const saved: any[] = [];
    return {
      saved,
      saveFileBytes: (async (input: any) => {
        saved.push(input);
        return {
          fileId: 'file-1',
          title: input.name,
          openPath: '/?view=files&file=file-1',
          size: input.bytes.byteLength,
          contentType: input.contentType,
          sha256: sha(input.bytes),
          ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
        };
      }) as any,
    };
  }

  test('saveWebFile stores the file with origin web, its source, and the work', async () => {
    const { saved, saveFileBytes } = saving();
    __setFilePullDepsForTest({ fetchRaw: async () => raw(PDF, 'application/pdf') as any, saveFileBytes });
    const result = await saveWebFile({
      userId: 'u1',
      url: 'https://www.irs.gov/pub/irs-pdf/fw9.pdf?x=1#y',
      name: 'Form W-9',
      workId: 'w1',
    });
    expect(result).toMatchObject({
      fileId: 'file-1',
      title: 'Form W-9.pdf',
      tier: 'fetch',
      sha256: sha(PDF),
    });
    expect(saved[0]).toMatchObject({
      userId: 'u1',
      name: 'Form W-9.pdf',
      contentType: 'application/pdf',
      origin: 'web',
      sourceUrl: 'https://www.irs.gov/pub/irs-pdf/fw9.pdf?x=1',
      workId: 'w1',
    });
  });

  test('saveBrowserDownload: a download through the Downloads API, without the address query', async () => {
    const { saved, saveFileBytes } = saving();
    const known = new Set(['old']);
    let collectedWith: any = null;
    __setFilePullDepsForTest({
      saveFileBytes,
      sessionDownloadIds: async () => known,
      collectDownload: (async (_sessionId: string, options: any) => {
        collectedWith = options;
        return {
          download: { id: 'd', sessionId: 's', filename: 'pay.pdf', mimeType: 'application/pdf', size: 5 },
          bytes: PDF,
        };
      }) as any,
    });
    const browser = {
      sessionId: () => 'sess-9',
      download: async () => ({
        via: 'download' as const,
        filename: 'pay.pdf',
        sourceUrl: 'https://pay.example/doc?token=abc',
      }),
    };
    const result = await saveBrowserDownload({ userId: 'u1', browser, ref: 'e4' });
    expect(result).toMatchObject({ title: 'pay.pdf', sourceUrl: 'https://pay.example/doc' });
    expect(collectedWith).toMatchObject({ known, filename: 'pay.pdf', maxBytes: WEB_FILE_MAX_BYTES });
    expect(saved[0]).toMatchObject({ origin: 'web', sourceUrl: 'https://pay.example/doc' });
  });

  test('saveBrowserDownload: the file the page shows, and its refusals', async () => {
    const { saveFileBytes } = saving();
    __setFilePullDepsForTest({ saveFileBytes, sessionDownloadIds: async () => new Set() });
    const shown = (file: any, sourceUrl = 'https://a.test/data/report.csv') => ({
      sessionId: () => 's',
      download: async () => ({ via: 'page' as const, file, sourceUrl }),
    });
    const csv = new TextEncoder().encode('a,b\n1,2');
    const result = await saveBrowserDownload({
      userId: 'u1',
      browser: shown({ status: 200, contentType: 'text/csv', url: '', bytes: csv }),
    });
    expect(result).toMatchObject({ title: 'report.csv', contentType: 'text/csv' });
    await expect(
      saveBrowserDownload({
        userId: 'u1',
        browser: shown({ status: 200, contentType: '', url: '', tooLarge: true }),
      }),
    ).rejects.toThrow('The file is larger than 25 MB.');
    await expect(
      saveBrowserDownload({
        userId: 'u1',
        browser: shown({ status: 200, contentType: 'text/html', url: '', bytes: HTML }),
      }),
    ).rejects.toThrow('The page is not a file.');
    await expect(
      saveBrowserDownload({
        userId: 'u1',
        browser: shown({ status: 200, contentType: 'image/png', url: '', bytes: PNG }, 'bad url'),
      }),
    ).resolves.toMatchObject({ title: 'download.png' });
    await expect(
      saveBrowserDownload({
        userId: 'u1',
        browser: { sessionId: () => null, download: async () => ({}) as any },
      }),
    ).rejects.toThrow('This browser cannot save files.');
    __setFilePullDepsForTest({
      saveFileBytes,
      sessionDownloadIds: async () => new Set(),
      collectDownload: async () => {
        throw new DownloadError('checksum', 'The file changed on the way. Try again.');
      },
    });
    const error = await saveBrowserDownload({
      userId: 'u1',
      browser: {
        sessionId: () => 's',
        download: async () => ({ via: 'download', filename: 'a.pdf', sourceUrl: '' }),
      },
    }).catch((e) => e);
    expect(error).toBeInstanceOf(WebFileError);
    expect(error.code).toBe('failed');
    __setFilePullDepsForTest({
      sessionDownloadIds: async () => new Set(),
      collectDownload: async () => {
        throw new Error('list failed');
      },
    });
    await expect(
      saveBrowserDownload({
        userId: 'u1',
        browser: {
          sessionId: () => 's',
          download: async () => ({ via: 'download', filename: 'a.pdf', sourceUrl: '' }),
        },
      }),
    ).rejects.toThrow('list failed');
  });
});
