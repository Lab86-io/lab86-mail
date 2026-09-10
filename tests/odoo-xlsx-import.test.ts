import { expect, mock, test } from 'bun:test';
import JSZip from 'jszip';
import { NextRequest } from 'next/server';
import { createDocumentImportPost, MAX_IMPORT_REQUEST_BYTES } from '../app/api/documents/import/route';
import { DocumentImportUnconfirmedError } from '../lib/documents/service';
import {
  assertSupportedContentTypes,
  inflateEntryBounded,
  inspectXlsxContainer,
  MAX_XLSX_ENTRY_BYTES,
} from '../lib/documents/xlsx-validation';

const model = {
  kind: 'sheet',
  version: 2,
  engine: 'o-spreadsheet',
  engineVersion: '19.0.50',
  workbook: {
    version: '19',
    sheets: [{ id: 'sheet', name: 'Plan', colNumber: 26, rowNumber: 100, cells: { A1: '=2+2' } }],
  },
};
async function archive(extra: Record<string, string> = {}) {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
  );
  zip.file('xl/workbook.xml', '<workbook/>');
  for (const [path, data] of Object.entries(extra)) zip.file(path, data);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
function harness() {
  const deps = {
    requireCurrentUser: mock(async () => ({ userId: 'owner', email: 'test@example.com', name: 'Test' })),
    enforceUserRateLimit: mock(async () => undefined),
    generateImportUploadUrl: mock(async () => 'https://storage.invalid/upload'),
    fetch: mock(async () => Response.json({ storageId: 'new-original' })),
    createDocument: mock(async (input: any) => ({ ...input, documentId: 'imported', currentRevision: 1 })),
  };
  return { deps, post: createDocumentImportPost(deps as any) };
}
function request(bytes: Uint8Array, snapshot: any = model, name = 'Plan.xlsx') {
  const form = new FormData();
  form.set('file', new File([bytes], name));
  form.set('model', JSON.stringify(snapshot));
  return new NextRequest('https://app.invalid/api/documents/import', { method: 'POST', body: form });
}

test('valid import stores exact originals and owner-scoped full workbook snapshot', async () => {
  const { deps, post } = harness();
  const bytes = await archive();
  const result = await post(request(bytes));
  expect(result.status).toBe(201);
  const payload = deps.createDocument.mock.calls[0][0];
  expect(payload.userId).toBe('owner');
  expect(payload.model).toEqual(model);
  expect(payload.importSource.storageId).toBe('new-original');
  expect(payload.importSource.size).toBe(bytes.length);
  expect(new Uint8Array((deps.fetch.mock.calls[0] as any)[1].body)).toEqual(bytes);
});

test('macro, renamed, invalid, oversized-model and oversized-body requests never upload bytes', async () => {
  for (const req of [
    request(await archive({ 'xl/vbaProject.bin': 'macro' })),
    request(new TextEncoder().encode('not an xlsx')),
    request(await archive(), model, 'old.xls'),
    request(await archive(), { ...model, workbook: { ...model.workbook, padding: 'x'.repeat(910_000) } }),
    new NextRequest('https://app.invalid/api/documents/import', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=test', 'content-length': '1' },
      body: new Uint8Array(MAX_IMPORT_REQUEST_BYTES + 1),
    }),
  ]) {
    const { deps, post } = harness();
    const response = await post(req);
    expect([400, 413]).toContain(response.status);
    expect(deps.generateImportUploadUrl).not.toHaveBeenCalled();
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.createDocument).not.toHaveBeenCalled();
  }
});

test('ambiguous create/cleanup is an explicit unconfirmed503, never success', async () => {
  const { deps, post } = harness();
  deps.createDocument.mockImplementation(async () => {
    throw new DocumentImportUnconfirmedError();
  });
  const response = await post(request(await archive()));
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ ok: false, code: 'IMPORT_UNCONFIRMED' });
});

test('archive metadata rejects encryption, oversized entries, hostile names, and macro content types', async () => {
  const bytes = await archive();
  const offset = bytes.findIndex(
    (_, index) =>
      bytes[index] === 0x50 && bytes[index + 1] === 0x4b && bytes[index + 2] === 1 && bytes[index + 3] === 2,
  );
  expect(offset).toBeGreaterThan(0);
  for (const kind of ['encrypted', 'expanded']) {
    const tampered = bytes.slice();
    const view = new DataView(tampered.buffer);
    if (kind === 'encrypted') view.setUint16(offset + 8, 1, true);
    else view.setUint32(offset + 24, MAX_XLSX_ENTRY_BYTES + 1, true);
    expect(() => inspectXlsxContainer(tampered)).toThrow();
  }
  const mismatchedLocalHeader = bytes.slice();
  new DataView(mismatchedLocalHeader.buffer).setUint16(6, 8, true);
  expect(() => inspectXlsxContainer(mismatchedLocalHeader)).toThrow('headers do not match');
  const invalidComment = bytes.slice();
  new DataView(invalidComment.buffer).setUint16(invalidComment.length - 2, 1, true);
  expect(() => inspectXlsxContainer(invalidComment)).toThrow('directory is invalid');
  expect(() => assertSupportedContentTypes('application/vnd.ms-excel.sheet.macroEnabled.main+xml')).toThrow();
  expect(() =>
    inspectXlsxContainer(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])),
  ).toThrow('Password-protected');
  expect(() => inspectXlsxContainer(new Uint8Array())).toThrow('empty');
  const hostile = await archive({ '../outside.xml': 'content' });
  expect(() => inspectXlsxContainer(hostile)).toThrow('unsafe path');
});

test('actual inflation stops at the limit even when uncompressed metadata lies', async () => {
  const zip = new JSZip();
  zip.file('large.xml', 'x'.repeat(100_000));
  await expect(inflateEntryBounded(zip.file('large.xml')!, 1024)).rejects.toThrow('too large');
});
