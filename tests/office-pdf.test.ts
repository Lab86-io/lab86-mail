import { afterEach, describe, expect, test } from 'bun:test';
import {
  __setOfficePdfDepsForTest,
  convertOfficeToPdf,
  exportOfficePdf,
  OfficeBlanksError,
  OfficeRevisionError,
  officeConvertUrl,
  saveDocxBytesAsPdf,
  saveOfficePdf,
} from '../lib/documents/office-pdf';
import type { OfficeFile } from '../lib/documents/office-service';
import { renderTemplate } from '../lib/documents/templates';
import type { SaveFileInput } from '../lib/files/saved-files';
import { sampleMemo } from '../scripts/fixtures/document-template-samples';

const PDF = new TextEncoder().encode('%PDF-1.7\nNorthwind Clinic memo\n%%EOF');
const env = { OFFICE_DOCUMENT_SERVER_URL: 'https://documents.example.test', NODE_ENV: 'production' };

function office(overrides: Partial<OfficeFile> = {}): OfficeFile {
  return {
    documentId: 'word-1',
    title: 'Check-in memo.docx',
    extension: 'docx',
    currentRevision: 3,
    createdAt: 1,
    updatedAt: 2,
    versions: [],
    version: { revision: 3, url: 'https://storage.example.test/word-1', size: 10, sha256: 'x' },
    ...overrides,
  };
}

async function harness(
  options: { convert?: () => Response | Promise<Response>; file?: OfficeFile | null; env?: object } = {},
) {
  const docx = (await renderTemplate('memo', sampleMemo)).bytes;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const saved: SaveFileInput[] = [];
  __setOfficePdfDepsForTest({
    env: () => ({ ...env, ...(options.env ?? {}) }),
    getOfficeFile: async () => (options.file === undefined ? office() : options.file),
    fetch: async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.startsWith('https://storage.example.test/')) return new Response(new Uint8Array(docx));
      return options.convert
        ? options.convert()
        : new Response(PDF, { headers: { 'content-type': 'application/pdf' } });
    },
    saveFileBytes: async (input) => {
      saved.push(input);
      return {
        fileId: 'upload_1',
        title: input.name,
        openPath: '/?view=files&file=upload_1',
        size: input.bytes.byteLength,
        contentType: input.contentType,
        sha256: 'hash',
      };
    },
  });
  return { docx, calls, saved };
}

afterEach(() => __setOfficePdfDepsForTest());

describe('office PDF export', () => {
  test('a Word file with empty blanks gets no PDF, and the error names the blanks', async () => {
    const { calls } = await harness();
    const { bytes } = await renderTemplate('invoice', {
      from: { name: 'Mara Ellison' },
      billTo: { name: 'Harbor Design' },
      items: [{ title: 'July', summary: 'Design review.', hours: 10, rate: 90 }],
      payment: 'Net 30',
    });
    __setOfficePdfDepsForTest({
      env: () => env,
      getOfficeFile: async () => office(),
      fetch: async (input, init) => {
        calls.push({ url: String(input), init });
        return new Response(new Uint8Array(bytes));
      },
    });
    const refusal = await exportOfficePdf('user-1', 'word-1').catch((error) => error);
    expect(refusal).toBeInstanceOf(OfficeBlanksError);
    expect(refusal.blanks).toEqual(['Invoice number', 'Invoice date']);
    expect(refusal.message).toBe(
      'Fill these blanks first: "Invoice number", "Invoice date". No PDF was made.',
    );
    expect(refusal.status).toBe(409);
    // It never reached the document server.
    expect(calls.map((call) => call.url)).toEqual(['https://storage.example.test/word-1']);
  });

  test('another revision is a refusal before the file is read', async () => {
    const { calls } = await harness();
    const refusal = await exportOfficePdf('user-1', 'word-1', { revision: 2 }).catch((error) => error);
    expect(refusal).toBeInstanceOf(OfficeRevisionError);
    expect(refusal.current).toBe(office().currentRevision);
    expect(calls).toEqual([]);
    await exportOfficePdf('user-1', 'word-1', { revision: office().currentRevision });
    await saveOfficePdf('user-1', 'word-1', undefined, { revision: office().currentRevision });
    await expect(saveOfficePdf('user-1', 'word-1', undefined, { revision: 1 })).rejects.toBeInstanceOf(
      OfficeRevisionError,
    );
  });

  test('the convert address follows the configured document server and rejects unsafe forms', () => {
    expect(officeConvertUrl(env)).toBe('https://documents.example.test/cool/convert-to/pdf');
    expect(officeConvertUrl({ ...env, OFFICE_CONVERT_URL: 'http://documents.railway.internal:9980' })).toBe(
      'http://documents.railway.internal:9980/cool/convert-to/pdf',
    );
    expect(
      officeConvertUrl({ OFFICE_DOCUMENT_SERVER_URL: 'http://localhost:9980', NODE_ENV: 'development' }),
    ).toBe('http://localhost:9980/cool/convert-to/pdf');
    for (const value of [
      'http://localhost:9980',
      'http://documents.example.test',
      'https://documents.example.test/path',
      'https://user:secret@documents.example.test',
      'not a url',
    ])
      expect(() => officeConvertUrl({ OFFICE_DOCUMENT_SERVER_URL: value, NODE_ENV: 'production' })).toThrow(
        'document server address',
      );
    expect(() => officeConvertUrl({})).toThrow('PDF export needs a document server.');
  });

  test('a Word file converts as saved and the PDF goes to Files with origin export', async () => {
    const { calls, saved, docx } = await harness();
    const result = await saveOfficePdf('user-1', 'word-1', 'work-9');
    expect(result).toMatchObject({
      fileId: 'upload_1',
      title: 'Check-in memo.pdf',
      contentType: 'application/pdf',
    });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      userId: 'user-1',
      name: 'Check-in memo.pdf',
      contentType: 'application/pdf',
      origin: 'export',
      workId: 'work-9',
    });
    expect(Buffer.from(saved[0].bytes).toString('latin1')).toContain('%PDF-1.7');
    const convert = calls.find((call) => call.url.endsWith('/cool/convert-to/pdf'))!;
    expect(convert.url).toBe('https://documents.example.test/cool/convert-to/pdf');
    expect(convert.init?.method).toBe('POST');
    expect(convert.init?.redirect).toBe('error');
    const form = convert.init?.body as FormData;
    const file = form.get('data') as File;
    expect(file.name).toBe('document.docx');
    expect(file.type).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array(docx));
    await saveOfficePdf('user-1', 'word-1');
    expect(saved[1].workId).toBeUndefined();
  });

  test('a blocked conversion says that the document server must allow this app', async () => {
    await harness({ convert: () => new Response('', { status: 403 }) });
    await expect(exportOfficePdf('user-1', 'word-1')).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining('does not accept PDF conversion from this app'),
    });
  });

  test('server errors, network errors, and bytes that are not a PDF never become a saved file', async () => {
    const failing = await harness({ convert: () => new Response('nope', { status: 500 }) });
    await expect(saveOfficePdf('user-1', 'word-1')).rejects.toThrow('could not make the PDF');
    expect(failing.saved).toHaveLength(0);
    await harness({
      convert: () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(exportOfficePdf('user-1', 'word-1')).rejects.toThrow('did not answer');
    await harness({ convert: () => new Response('<html>login</html>') });
    await expect(exportOfficePdf('user-1', 'word-1')).rejects.toThrow('did not return a PDF');
  });

  test('missing files, other Office kinds, and bad archives fail before any conversion', async () => {
    const missing = await harness({ file: null });
    await expect(exportOfficePdf('user-1', 'nope')).rejects.toMatchObject({ status: 404 });
    expect(missing.calls).toHaveLength(0);
    await harness({ file: office({ extension: 'xlsx' }) });
    await expect(exportOfficePdf('user-1', 'sheet')).rejects.toThrow('Word files only');
    const bad = await harness();
    await expect(convertOfficeToPdf(new TextEncoder().encode('not a zip'), 'docx')).rejects.toThrow();
    expect(bad.calls).toHaveLength(0);
  });

  test('DOCX bytes of a text document convert and save under the document title', async () => {
    const { docx, saved } = await harness();
    const result = await saveDocxBytesAsPdf('user-1', docx, 'Decision memo', 'work-2');
    expect(result.title).toBe('Decision memo.pdf');
    expect(saved[0]).toMatchObject({ origin: 'export', workId: 'work-2', name: 'Decision memo.pdf' });
    await saveDocxBytesAsPdf('user-1', docx, '');
    expect(saved[1]).toMatchObject({ name: 'document.pdf' });
    expect(saved[1].workId).toBeUndefined();
  });
});
