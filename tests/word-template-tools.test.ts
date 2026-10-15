import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { resolveToolShape } from '../lib/ai/tool-shapes';
import { type AlbatrossDocumentRecord, createDefaultDocumentModel } from '../lib/documents/model';
import { OfficeError } from '../lib/documents/office-security';
import type { OfficeFile } from '../lib/documents/office-service';
import { readWordBlanks } from '../lib/documents/word-package';
import { createWordService } from '../lib/documents/word-service';
import { __setDocumentToolDepsForTest, documentExport } from '../lib/tools/documents';
import { toolRisk } from '../lib/tools/registry';
import { wordDocumentCreate, wordDocumentEdit, wordDocumentGet } from '../lib/tools/word-documents';
import {
  sampleInvoice,
  sampleLetter,
  sampleMemo,
  sampleReport,
} from '../scripts/fixtures/document-template-samples';
import { runTool } from './tools/harness';

afterEach(() => __setDocumentToolDepsForTest());

const issues = (result: { success: boolean; error?: z.ZodError }) =>
  (result.error?.issues ?? []).map((issue) => `${issue.path.join('.')}: ${issue.message}`);

function wordService() {
  let stored: Uint8Array | undefined;
  const created: any[] = [];
  const file = (): OfficeFile => ({
    documentId: 'word-9',
    title: created.at(-1)?.title ?? 'x.docx',
    extension: 'docx',
    currentRevision: 1,
    createdAt: 1,
    updatedAt: 1,
    versions: [],
    version: { revision: 1, url: 'https://storage.example.test/word-9', size: 1, sha256: 'x' },
  });
  const service = createWordService({
    requireOffice: () => ({
      server: 'https://office.test',
      app: 'https://app.test',
      secret: 's',
      provider: 'collabora',
    }),
    storeOfficeBytes: async (_user: string, bytes: Uint8Array) => {
      stored = bytes;
      return 'storage-9';
    },
    createOfficeFile: (async (input: any) => {
      created.push(input);
      return file();
    }) as any,
    getOfficeFile: (async () => file()) as any,
    fetch: (async () => new Response(new Uint8Array(stored!))) as any,
    convexMutation: (async () => ({ ok: true, revision: 2 })) as any,
  });
  return { service, stored: () => stored!, created };
}

describe('word_document_create with a template', () => {
  test('the input takes a template with its typed data and refuses mixed or missing parts', () => {
    const input = wordDocumentCreate.input;
    for (const [template, data] of [
      ['invoice', sampleInvoice],
      ['letter', sampleLetter],
      ['memo', sampleMemo],
      ['report', sampleReport],
    ] as const)
      expect(input.safeParse({ title: 'Doc', template, data })).toMatchObject({ success: true });
    expect(issues(input.safeParse({ title: 'Doc', data: sampleMemo }))).toEqual([
      'template: Set template when you send data.',
    ]);
    expect(issues(input.safeParse({ title: 'Doc', template: 'memo' }))).toEqual([
      'data: Send data for the memo template.',
    ]);
    expect(
      issues(
        input.safeParse({ title: 'Doc', template: 'memo', data: sampleMemo, sourceDocumentId: 'simple' }),
      ),
    ).toEqual(['sourceDocumentId: Use a template or a source document, not both.']);
    expect(issues(input.safeParse({ title: 'Doc', template: 'invoice', data: sampleMemo }))[0]).toMatch(
      /^data\./,
    );
    expect(input.safeParse({ title: 'Doc', edits: [{ op: 'insert_paragraph', text: 'x' }] }).success).toBe(
      true,
    );
  });

  test('the model sees four typed data shapes with descriptions and no style fields', () => {
    const json = z.toJSONSchema(wordDocumentCreate.input, { unrepresentable: 'any', io: 'input' }) as any;
    expect(json.properties.template.enum).toEqual(['invoice', 'letter', 'memo', 'report']);
    expect(json.properties.data.anyOf).toHaveLength(4);
    const invoice = json.properties.data.anyOf[0];
    expect(invoice.properties.items.items.properties.hours.description).toContain('Hours worked');
    const fields = JSON.stringify(json.properties.data);
    for (const style of ['"font"', '"size"', '"color"', '"border"']) expect(fields).not.toContain(style);
    expect(wordDocumentCreate.description).toContain('always set template and send data');
  });

  test('the service renders the template, applies edits, and returns the empty blanks in page order', async () => {
    const { service, stored, created } = wordService();
    const result = await service.create('owner', {
      title: 'Invoice INV-1042',
      template: 'invoice',
      data: sampleInvoice,
    });
    expect(result).toMatchObject({
      ok: true,
      documentId: 'word-9',
      template: 'invoice',
      blanks: ['Summary: August 2026', 'Payment details'],
    });
    expect(created[0].title).toBe('Invoice INV-1042.docx');
    const edited = await service.create('owner', {
      title: 'Invoice INV-1042',
      template: 'invoice',
      data: sampleInvoice,
      edits: [{ op: 'fill_blank', blank: 'Payment details', value: 'Bank transfer within 30 days.' }],
    });
    expect(edited.blanks).toEqual(['Summary: August 2026']);
    expect((await readWordBlanks(stored()))[1]).toMatchObject({ value: 'Bank transfer within 30 days.' });
    const plain = await service.create('owner', { title: 'Notes' });
    expect(plain).not.toHaveProperty('blanks');
    expect(plain).not.toHaveProperty('template');
    await expect(
      service.create('owner', { title: 'X', template: 'memo', data: sampleMemo, sourceDocumentId: 'simple' }),
    ).rejects.toThrow('not both');
    expect(
      wordDocumentCreate.output.safeParse({ ...result, title: 'Invoice INV-1042.docx', revision: 1 }).success,
    ).toBe(true);
  });

  test('word_document_get reports blanks and word_document_edit accepts fill_blank', async () => {
    const { service } = wordService();
    await service.create('owner', { title: 'Report', template: 'report', data: sampleReport });
    const read = await service.read('owner', 'word-9');
    expect(read.blanks).toEqual([{ name: 'Date', value: '', filled: false }]);
    expect(wordDocumentGet.output.safeParse(read).success).toBe(true);
    expect(wordDocumentGet.description).toContain('blanks');
    expect(
      wordDocumentEdit.input.safeParse({
        documentId: 'word-9',
        expectedRevision: 1,
        edits: [{ op: 'fill_blank', blank: 'Date', value: 'October 15, 2026' }],
      }).success,
    ).toBe(true);
    expect(
      wordDocumentEdit.input.safeParse({
        documentId: 'word-9',
        expectedRevision: 1,
        edits: [{ op: 'fill_blank', blank: '', value: 'x' }],
      }).success,
    ).toBe(false);
    const edited = await service.edit('owner', 'word-9', 1, [
      { op: 'fill_blank', blank: 'date', value: 'October 15, 2026' },
    ]);
    expect(edited.ok).toBe(true);
    expect((await service.read('owner', 'word-9')).blanks[0]).toEqual({
      name: 'Date',
      value: 'October 15, 2026',
      filled: true,
    });
  });
});

describe('document_export with format pdf', () => {
  const saved = {
    fileId: 'upload_7',
    title: 'Check-in memo.pdf',
    openPath: '/?view=files&file=upload_7',
    size: 2048,
    contentType: 'application/pdf',
    sha256: 'abc',
  };
  const record = (kind: AlbatrossDocumentRecord['kind']): AlbatrossDocumentRecord => ({
    documentId: 'doc-1',
    kind,
    title: 'Decision memo',
    model: createDefaultDocumentModel(kind, 'doc-1'),
    currentRevision: 1,
    sourceRefs: [],
    createdAt: 1,
    updatedAt: 1,
  });

  test('a Word file becomes a saved PDF in the shared file shape', async () => {
    const calls: string[] = [];
    __setDocumentToolDepsForTest({
      saveOfficePdf: async (userId, documentId) => {
        calls.push(`${userId}:${documentId}`);
        return saved;
      },
    });
    const result = await runTool(documentExport.handler, { documentId: 'word-1', format: 'pdf' });
    expect(result).toEqual({ ok: true, format: 'pdf', documentId: 'word-1', ...saved });
    expect(calls).toEqual(['test_user_tools:word-1']);
    expect(documentExport.output.safeParse(result).success).toBe(true);
    expect(toolRisk(documentExport)).toBe('write_self');
    const shape = resolveToolShape('document_export', { documentId: 'word-1', format: 'pdf' }, result) as any;
    expect(shape.title).toBe('Check-in memo.pdf');
    expect(shape.path).toBe('/?view=files&file=upload_7');
  });

  test('a text document converts from its DOCX export; other kinds and other errors fail', async () => {
    const notWord = async () => {
      throw new OfficeError('Word document not found.', 404);
    };
    const converted: string[] = [];
    __setDocumentToolDepsForTest({
      saveOfficePdf: notWord,
      getDocument: (async () => record('doc')) as any,
      saveDocxBytesAsPdf: async (_userId, bytes, title) => {
        converted.push(`${title}:${bytes.byteLength > 0}`);
        return { ...saved, title: `${title}.pdf` };
      },
    });
    expect(await runTool(documentExport.handler, { documentId: 'doc-1', format: 'pdf' })).toMatchObject({
      fileId: 'upload_7',
      title: 'Decision memo.pdf',
    });
    expect(converted).toEqual(['Decision memo:true']);
    __setDocumentToolDepsForTest({
      saveOfficePdf: notWord,
      getDocument: (async () => record('deck')) as any,
    });
    await expect(runTool(documentExport.handler, { documentId: 'doc-1', format: 'pdf' })).rejects.toThrow(
      'Word files and text documents',
    );
    __setDocumentToolDepsForTest({ saveOfficePdf: notWord, getDocument: (async () => null) as any });
    await expect(runTool(documentExport.handler, { documentId: 'doc-1', format: 'pdf' })).rejects.toThrow(
      'Document not found',
    );
    __setDocumentToolDepsForTest({
      saveOfficePdf: async () => {
        throw new OfficeError('The document server does not accept PDF conversion from this app.', 503);
      },
    });
    await expect(runTool(documentExport.handler, { documentId: 'word-1', format: 'pdf' })).rejects.toThrow(
      'does not accept PDF conversion',
    );
  });

  test('the native format keeps its download link', async () => {
    __setDocumentToolDepsForTest({ getDocument: (async () => record('doc')) as any });
    expect(await runTool(documentExport.handler, { documentId: 'doc-1', format: 'native' })).toMatchObject({
      downloadPath: '/api/documents/doc-1/export',
      fidelity: 'full',
    });
    expect(documentExport.input.safeParse({ documentId: 'doc-1', format: 'png' }).success).toBe(false);
  });
});
