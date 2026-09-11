import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { type AlbatrossDocumentRecord, createDefaultDocumentModel } from '../lib/documents/model';
import {
  __setDocumentServiceDepsForTest,
  applyDocumentSuggestion,
  createDocument,
  createImportedDocument,
  DocumentImportUnconfirmedError,
  generateImportUploadUrl,
  getDocumentImportSource,
  listDocumentRevisions,
  restoreDocumentRevision,
  updateDocument,
} from '../lib/documents/service';
import { DocumentTooLargeError, type SheetWorkbookModel } from '../lib/documents/sheet-workbook';

const input = {
  userId: 'owner',
  kind: 'sheet' as const,
  title: 'Import',
  importSource: {
    format: 'xlsx' as const,
    filename: 'Import.xlsx',
    mimeType: 'application/xlsx',
    size: 24,
    sha256: 'synthetic',
    storageId: 'fresh-upload',
    warnings: [],
    importedAt: 1,
  },
};
afterEach(() => __setDocumentServiceDepsForTest());

test('successful import creates one reserved identity and retains original metadata without compensation', async () => {
  const identity = mock(() => 'reserved-id');
  const committed = {
    documentId: 'reserved-id',
    kind: 'sheet',
    title: 'Import',
    currentRevision: 1,
    importSource: { ...input.importSource, revision: 1 },
  };
  const mutation = mock(async (_ref: any, _args: any) => committed);
  __setDocumentServiceDepsForTest({ randomUUID: identity as any, convexMutation: mutation as any });
  expect(await createImportedDocument(input)).toBe(committed as any);
  expect(identity).toHaveBeenCalledTimes(1);
  expect(mutation).toHaveBeenCalledTimes(1);
  expect(getFunctionName(mutation.mock.calls[0][0])).toBe('documents:create');
  expect(mutation.mock.calls[0][1]).toMatchObject({
    userId: 'owner',
    documentId: 'reserved-id',
    kind: 'sheet',
    title: 'Import',
    importSource: input.importSource,
  });
});

test('failed import compensates using the exact identity chosen before create', async () => {
  const calls: Array<{ name: string; args: any }> = [];
  __setDocumentServiceDepsForTest({
    randomUUID: (() => 'reserved-id') as any,
    convexMutation: (async (ref: any, args: any) => {
      const name = getFunctionName(ref);
      calls.push({ name, args });
      if (name === 'documents:create') throw new Error('Known create failure');
      return { status: 'cancelled' };
    }) as any,
  });
  await expect(createImportedDocument(input)).rejects.toThrow('Known create failure');
  expect(calls.map((call) => call.name)).toEqual(['documents:create', 'documents:cancelImport']);
  expect(calls[0].args.documentId).toBe('reserved-id');
  expect(calls[1].args).toEqual({ userId: 'owner', documentId: 'reserved-id', storageId: 'fresh-upload' });
});

test('ambiguous create resolves to the existing import instead of duplicating it or reporting failure', async () => {
  const committed = { documentId: 'reserved-id', title: 'Import', currentRevision: 1 };
  __setDocumentServiceDepsForTest({
    randomUUID: (() => 'reserved-id') as any,
    convexMutation: (async (ref: any) => {
      if (getFunctionName(ref) === 'documents:create') throw new Error('Response lost');
      return { status: 'attached', document: committed };
    }) as any,
  });
  expect(await createImportedDocument(input)).toEqual(committed as any);
});

test('ambiguous cleanup reports unconfirmed rather than falsely saying nothing imported', async () => {
  const log = spyOn(console, 'error').mockImplementation(() => {});
  __setDocumentServiceDepsForTest({
    randomUUID: (() => 'reserved-id') as any,
    convexMutation: (async () => {
      throw new Error('Transport unavailable');
    }) as any,
  });
  try {
    await expect(createImportedDocument(input)).rejects.toBeInstanceOf(DocumentImportUnconfirmedError);
    expect(log).toHaveBeenCalledTimes(1);
  } finally {
    log.mockRestore();
  }
});

test.each([
  undefined,
  { documentId: 'different-import' },
])('an attached source without the exact document (%p) cannot masquerade as successful import', async (document) => {
  const mutation = mock(async (ref: any, _args: any) => {
    if (getFunctionName(ref) === 'documents:create') throw new Error('Response lost');
    return { status: 'attached', document };
  });
  __setDocumentServiceDepsForTest({
    randomUUID: (() => 'reserved-id') as any,
    convexMutation: mutation as any,
  });
  await expect(createImportedDocument(input)).rejects.toBeInstanceOf(DocumentImportUnconfirmedError);
  expect(mutation).toHaveBeenCalledTimes(2);
  expect(mutation.mock.calls[1][1]).toEqual({
    userId: 'owner',
    documentId: 'reserved-id',
    storageId: 'fresh-upload',
  });
});

test('upload and original-source helpers preserve signed URLs and scope original retrieval to the owner', async () => {
  const original = {
    ...input.importSource,
    revision: 1,
    currentRevision: 4,
    url: 'https://storage.example.test/original?signature=synthetic',
  };
  const query = mock(async (_ref: any, args: any) => (args.documentId === 'reserved-id' ? original : null));
  const mutation = mock(
    async (_ref: any, _args: any) => 'https://storage.example.test/upload?signature=synthetic',
  );
  __setDocumentServiceDepsForTest({ convexMutation: mutation as any, convexQuery: query as any });
  expect(await generateImportUploadUrl()).toBe('https://storage.example.test/upload?signature=synthetic');
  expect(getFunctionName(mutation.mock.calls[0][0])).toBe('documents:generateImportUploadUrl');
  expect(mutation.mock.calls[0][1]).toEqual({});
  expect(await getDocumentImportSource('owner', 'reserved-id')).toEqual(original);
  expect(getFunctionName(query.mock.calls[0][0])).toBe('documents:getImportSource');
  expect(query.mock.calls[0][1]).toEqual({ userId: 'owner', documentId: 'reserved-id' });
  expect(await getDocumentImportSource('owner', 'missing')).toBeNull();
});

test('revision history is bounded and restoration forwards the optimistic revision guard and conflicts', async () => {
  const revision = {
    revision: 1,
    title: 'Original',
    model: createDefaultDocumentModel('sheet'),
    reason: 'xlsx_import',
    actor: 'user',
    createdAt: 1,
  };
  const query = mock(async (_ref: any, _args: any) => [revision]);
  const mutation = mock(async (_ref: any, args: any) =>
    args.expectedRevision === 4 ? { ok: true } : { ok: false, code: 'REVISION_CONFLICT' },
  );
  __setDocumentServiceDepsForTest({ convexMutation: mutation as any, convexQuery: query as any });
  expect(await listDocumentRevisions('owner', 'reserved-id')).toEqual([revision]);
  expect(getFunctionName(query.mock.calls[0][0])).toBe('documents:listRevisions');
  expect(query.mock.calls[0][1]).toEqual({ userId: 'owner', documentId: 'reserved-id', limit: 100 });
  const restore = { userId: 'owner', documentId: 'reserved-id', revision: 1, expectedRevision: 4 };
  expect(await restoreDocumentRevision(restore)).toEqual({ ok: true });
  expect(getFunctionName(mutation.mock.calls[0][0])).toBe('documents:restoreRevision');
  expect(mutation.mock.calls[0][1]).toEqual(restore);
  expect(await restoreDocumentRevision({ ...restore, expectedRevision: 3 })).toEqual({
    ok: false,
    code: 'REVISION_CONFLICT',
  });
});

function engineWorkbook(): SheetWorkbookModel {
  return {
    kind: 'sheet',
    version: 2,
    engine: 'o-spreadsheet',
    engineVersion: '19.0.50',
    workbook: {
      version: '19',
      sheets: [{ id: 'plan', name: 'Plan', rowNumber: 100, colNumber: 26, cells: { A1: '=2+2' } }],
    },
  };
}

test('reviewed engine suggestions forward the exact snapshot, proposal identity, and revision to atomic apply', async () => {
  const model = engineWorkbook();
  const document: AlbatrossDocumentRecord = {
    documentId: 'reserved-id',
    kind: 'sheet',
    title: 'Plan',
    model,
    currentRevision: 5,
    sourceRefs: [],
    createdAt: 1,
    updatedAt: 2,
  };
  const result = { ok: true, document };
  const mutation = mock(async (_ref: any, _args: any) => result);
  __setDocumentServiceDepsForTest({ convexMutation: mutation as any });
  const apply = {
    userId: 'owner',
    documentId: 'reserved-id',
    suggestionId: 'proposal',
    expectedRevision: 4,
    model,
  };
  expect(await applyDocumentSuggestion(apply)).toBe(result as any);
  expect(getFunctionName(mutation.mock.calls[0][0])).toBe('documents:applySuggestion');
  expect(mutation.mock.calls[0][1]).toBe(apply);
  expect(mutation.mock.calls[0][1].model).toBe(model);
});

test('oversized canonical snapshots fail before create, update, or suggestion mutations', async () => {
  const model = engineWorkbook();
  // Unknown plugin fields are intentionally preserved by the engine snapshot schema.
  model.workbook.customPlugin = { data: 'é'.repeat(500_000) };
  const mutation = mock(async (_ref: any, _args: any) => ({ ok: true }));
  const query = mock(async (_ref: any, _args: any) => 'sheet');
  __setDocumentServiceDepsForTest({ convexMutation: mutation as any, convexQuery: query as any });
  await expect(createDocument({ userId: 'owner', kind: 'sheet', model })).rejects.toBeInstanceOf(
    DocumentTooLargeError,
  );
  await expect(
    updateDocument({ userId: 'owner', documentId: 'reserved-id', expectedRevision: 4, model }),
  ).rejects.toBeInstanceOf(DocumentTooLargeError);
  await expect(
    applyDocumentSuggestion({
      userId: 'owner',
      documentId: 'reserved-id',
      suggestionId: 'proposal',
      expectedRevision: 4,
      model,
    }),
  ).rejects.toBeInstanceOf(DocumentTooLargeError);
  expect(mutation).not.toHaveBeenCalled();
  expect(query).toHaveBeenCalledTimes(1);
  expect(getFunctionName(query.mock.calls[0][0])).toBe('documents:getKind');
  expect(query.mock.calls[0][1]).toEqual({ userId: 'owner', documentId: 'reserved-id' });
});
