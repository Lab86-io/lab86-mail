import { afterEach, describe, expect, mock, test } from 'bun:test';
import { type AlbatrossDocumentRecord, createDefaultDocumentModel } from '../lib/documents/model';
import {
  __setDocumentToolDepsForTest,
  documentApplyInstruction,
  documentCreate,
  documentExport,
  documentGet,
  documentList,
  documentPublishGoogle,
  documentSuggestChanges,
} from '../lib/tools/documents';
import { __setCloudFileToolDepsForTest, cloudFileSearch, googleFileImport } from '../lib/tools/files';
import { runTool, toolContext } from './tools/harness';

function record(overrides: Partial<AlbatrossDocumentRecord> = {}): AlbatrossDocumentRecord {
  return {
    documentId: 'document-1',
    kind: 'doc',
    title: 'Decision memo',
    model: createDefaultDocumentModel('doc', 'document-1'),
    currentRevision: 2,
    sourceRefs: [{ kind: 'mail', id: 'thread-1' }],
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

afterEach(() => {
  __setDocumentToolDepsForTest();
  __setCloudFileToolDepsForTest();
});

describe('document tools', () => {
  test('creates a grounded private file, records undo, and optionally publishes it', async () => {
    const proposal = mock(async () => ({
      title: 'Generated memo',
      summary: 'Drafted from source material',
      model: createDefaultDocumentModel('doc', 'generated'),
    }));
    const create = mock(async (input: any) =>
      record({
        title: input.title,
        model: input.model,
      }),
    );
    const recordOperation = mock(async () => 'operation-1');
    const publish = mock(async () => ({
      connectionId: 'google-1',
      fileId: 'file-1',
      mimeType: 'application/vnd.google-apps.document',
      webUrl: 'https://docs.google.com/document/d/file-1/edit',
      providerVersion: '3',
      syncedRevision: 2,
    }));
    __setDocumentToolDepsForTest({
      createDocument: create as any,
      generateDocumentProposal: proposal as any,
      publishDocumentToGoogle: publish as any,
      recordOperation: recordOperation as any,
    });

    const result = await runTool(
      documentCreate.handler,
      {
        kind: 'doc',
        title: 'Requested title',
        instructions: 'Draft the decision',
        sourceContext: 'Grounded source',
        sourceRefs: [{ kind: 'mail', id: 'thread-1' }],
        publishToGoogle: true,
        googleConnectionId: 'google-1',
      },
      toolContext(),
    );

    expect(result).toMatchObject({
      ok: true,
      documentId: 'document-1',
      title: 'Requested title',
      googleUrl: 'https://docs.google.com/document/d/file-1/edit',
    });
    expect(proposal.mock.calls[0][0]).toMatchObject({
      userId: 'test_user_tools',
      instruction: 'Draft the decision',
    });
    expect(recordOperation.mock.calls[0][0]).toMatchObject({
      tool: 'document_create',
      inverse: { kind: 'documents.archive', payload: { documentId: 'document-1' } },
    });
    expect(publish).toHaveBeenCalledTimes(1);
  });

  test('creates a manual file without AI or Google and requires authentication', async () => {
    const create = mock(async (input: any) =>
      record({ kind: 'sheet', title: input.title, model: createDefaultDocumentModel('sheet') }),
    );
    const proposal = mock(async () => {
      throw new Error('must not generate');
    });
    const publish = mock(async () => {
      throw new Error('must not publish');
    });
    __setDocumentToolDepsForTest({
      createDocument: create as any,
      generateDocumentProposal: proposal as any,
      publishDocumentToGoogle: publish as any,
      recordOperation: (async () => 'operation') as any,
    });

    const result = await runTool(documentCreate.handler, {
      kind: 'sheet',
      title: 'Manual model',
      publishToGoogle: false,
    });
    expect(result).toMatchObject({ kind: 'sheet', googleUrl: undefined });
    expect(proposal).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    await expect(
      runTool(
        documentCreate.handler,
        { kind: 'doc', title: 'No user', publishToGoogle: false },
        toolContext({ userId: null }),
      ),
    ).rejects.toThrow('Not authenticated');
  });

  test('returns the created file when optional Google publishing fails', async () => {
    __setDocumentToolDepsForTest({
      createDocument: (async () => record()) as any,
      publishDocumentToGoogle: (async () => {
        throw new Error('Reconnect Google Drive.');
      }) as any,
      recordOperation: (async () => 'operation') as any,
    });

    const result = await runTool(documentCreate.handler, {
      kind: 'doc',
      title: 'Private fallback',
      publishToGoogle: true,
    });

    expect(result).toMatchObject({
      ok: true,
      documentId: 'document-1',
      googleUrl: undefined,
      publishError: 'Reconnect Google Drive.',
    });
  });

  test('lists, reads, exports, and publishes user-owned documents', async () => {
    const listed = [
      record({
        google: {
          connectionId: 'google-1',
          fileId: 'file-1',
          mimeType: 'application/vnd.google-apps.document',
          webUrl: 'https://docs.google.com/document/d/file-1/edit',
          providerVersion: '4',
          syncedRevision: 2,
          lastSyncedAt: 2_000,
        },
      }),
    ];
    const get = mock(async (_userId: string, documentId: string) =>
      documentId === 'missing' ? null : ({ ...listed[0], suggestions: [] } as any),
    );
    __setDocumentToolDepsForTest({
      getDocument: get as any,
      listDocuments: (async () => listed) as any,
      publishDocumentToGoogle: (async () => ({
        connectionId: 'google-1',
        fileId: 'file-1',
        mimeType: 'application/vnd.google-apps.document',
        webUrl: 'https://docs.google.com/document/d/file-1/edit',
        providerVersion: '5',
        syncedRevision: 2,
      })) as any,
    });

    const list = await runTool(documentList.handler, { kind: undefined, limit: 50 });
    expect(list.documents[0]).toMatchObject({
      documentId: 'document-1',
      revision: 2,
      googleUrl: 'https://docs.google.com/document/d/file-1/edit',
    });
    const read = await runTool(documentGet.handler, { documentId: 'document-1' });
    expect(read.document.documentId).toBe('document-1');
    expect(typeof read.text).toBe('string');
    const exported = await runTool(documentExport.handler, { documentId: 'document-1' });
    expect(exported.downloadPath).toBe('/api/documents/document-1/export');
    const published = await runTool(documentPublishGoogle.handler, {
      documentId: 'document-1',
      connectionId: 'google-1',
    });
    expect(published).toMatchObject({ ok: true, fileId: 'file-1', syncedRevision: 2 });

    await expect(runTool(documentGet.handler, { documentId: 'missing' })).rejects.toThrow(
      'Document not found',
    );
    await expect(runTool(documentExport.handler, { documentId: 'missing' })).rejects.toThrow(
      'Document not found',
    );
    await expect(
      runTool(documentPublishGoogle.handler, { documentId: 'missing', connectionId: undefined }),
    ).rejects.toThrow('Document not found');
  });

  test('creates reviewable suggestions and applies explicit instructions as revisions', async () => {
    const current = { ...record(), suggestions: [] };
    const proposal = mock(async () => ({
      title: 'Revised memo',
      summary: 'Made the recommendation clearer',
      model: {
        kind: 'doc' as const,
        version: 1 as const,
        blocks: [{ id: 'p', type: 'paragraph' as const, text: 'Choose Acme.' }],
      },
    }));
    const update = mock(async () => ({
      ok: true as const,
      document: record({ title: 'Revised memo', currentRevision: 3 }),
    }));
    __setDocumentToolDepsForTest({
      createDocumentSuggestion: (async () => ({
        ok: true,
        suggestionId: 'suggestion-1',
      })) as any,
      generateDocumentProposal: proposal as any,
      getDocument: (async (_userId: string, documentId: string) =>
        documentId === 'missing' ? null : current) as any,
      updateDocument: update as any,
    });

    const suggestion = await runTool(documentSuggestChanges.handler, {
      documentId: 'document-1',
      instruction: 'Clarify the choice',
      sourceContext: 'Acme scored highest',
    });
    expect(suggestion).toMatchObject({
      suggestionId: 'suggestion-1',
      title: 'Revised memo',
      openPath: '/?view=files&document=document-1',
    });
    const applied = await runTool(documentApplyInstruction.handler, {
      documentId: 'document-1',
      instruction: 'Apply the clearer choice',
      sourceContext: undefined,
    });
    expect(applied).toMatchObject({ revision: 3, summary: 'Made the recommendation clearer' });
    expect(update.mock.calls[0][0]).toMatchObject({
      expectedRevision: 2,
      actor: 'ai',
    });

    await expect(
      runTool(documentSuggestChanges.handler, {
        documentId: 'missing',
        instruction: 'No file',
        sourceContext: undefined,
      }),
    ).rejects.toThrow('Document not found');

    __setDocumentToolDepsForTest({
      generateDocumentProposal: proposal as any,
      getDocument: (async () => current) as any,
      updateDocument: (async () => ({ ok: false, code: 'REVISION_CONFLICT' })) as any,
    });
    await expect(
      runTool(documentApplyInstruction.handler, {
        documentId: 'document-1',
        instruction: 'Race the editor',
        sourceContext: undefined,
      }),
    ).rejects.toThrow('file changed while Albatross was editing');
  });
});

describe('cloud file tools', () => {
  test('searches every selected provider, tolerates one failure, and enforces connection identity', async () => {
    const browse = mock(async (input: any) => {
      if (input.connectionId === 'onedrive-1') throw new Error('provider unavailable');
      return {
        items: [
          {
            id: 'file-1',
            name: 'Decision memo',
            provider: 'google_drive',
            connectionId: input.connectionId,
            mimeType: 'application/vnd.google-apps.document',
            modifiedAt: 2_000,
            webUrl: 'https://docs.google.com/document/d/file-1/edit',
            isFolder: false,
          },
          {
            id: 'folder-1',
            name: 'Briefs',
            provider: 'google_drive',
            connectionId: input.connectionId,
            isFolder: true,
          },
        ],
      };
    });
    __setCloudFileToolDepsForTest({
      browseCloudFiles: browse as any,
      listCloudFileConnections: (async () => [
        { connectionId: 'google-1', provider: 'google_drive', status: 'connected', scopes: [] },
        { connectionId: 'onedrive-1', provider: 'onedrive', status: 'connected', scopes: [] },
      ]) as any,
    });

    const result = await runTool(cloudFileSearch.handler, {
      query: 'decision',
      connectionId: undefined,
      limit: 1,
    });
    expect(result.files).toEqual([
      expect.objectContaining({ id: 'file-1', provider: 'google_drive', isFolder: false }),
    ]);
    expect(result.errors).toEqual([{ connectionId: 'onedrive-1', error: 'provider unavailable' }]);
    expect(browse).toHaveBeenCalledTimes(2);

    await expect(
      runTool(cloudFileSearch.handler, {
        query: '',
        connectionId: 'missing',
        limit: 50,
      }),
    ).rejects.toThrow('File connection not found');
    await expect(
      runTool(
        cloudFileSearch.handler,
        { query: '', connectionId: undefined, limit: 50 },
        toolContext({ userId: null }),
      ),
    ).rejects.toThrow('Not authenticated');
  });

  test('reuses existing Google imports and creates a linked canonical file once', async () => {
    const existing = record({ documentId: 'existing-document' });
    __setCloudFileToolDepsForTest({
      findDocumentByGoogleFile: (async (input: any) =>
        input.fileId === 'existing-file' ? existing : null) as any,
    });

    const reused = await runTool(googleFileImport.handler, {
      connectionId: 'google-1',
      fileId: 'existing-file',
      mimeType: 'application/vnd.google-apps.document',
      webUrl: undefined,
    });
    expect(reused).toMatchObject({
      documentId: 'existing-document',
      existing: true,
      revision: 2,
    });

    const create = mock(async (input: any) =>
      record({
        documentId: 'imported-document',
        kind: input.kind,
        title: input.title,
        model: input.model,
        currentRevision: 1,
        sourceRefs: input.sourceRefs,
      }),
    );
    const link = mock(async () => ({ ok: true }));
    __setCloudFileToolDepsForTest({
      createDocument: create as any,
      findDocumentByGoogleFile: (async () => null) as any,
      importGoogleNativeFile: (async () => ({
        kind: 'sheet',
        title: 'Vendor comparison',
        model: createDefaultDocumentModel('sheet', 'imported'),
        webUrl: 'https://docs.google.com/spreadsheets/d/new/edit',
        providerVersion: '8',
      })) as any,
      linkGoogleDocument: link as any,
    });
    const imported = await runTool(googleFileImport.handler, {
      connectionId: 'google-1',
      fileId: 'new-file',
      mimeType: 'application/vnd.google-apps.spreadsheet',
      webUrl: undefined,
    });
    expect(imported).toMatchObject({
      documentId: 'imported-document',
      kind: 'sheet',
      existing: false,
      revision: 1,
    });
    expect(create.mock.calls[0][0].sourceRefs[0]).toMatchObject({
      kind: 'google_drive',
      id: 'new-file',
    });
    expect(link.mock.calls[0][0]).toMatchObject({
      providerVersion: '8',
      syncedRevision: 1,
    });
  });

  test('archives a new Google import if the canonical provider link cannot be committed', async () => {
    const archive = mock(async () => undefined);
    __setCloudFileToolDepsForTest({
      archiveDocument: archive as any,
      createDocument: (async () =>
        record({
          documentId: 'orphan-candidate',
          currentRevision: 1,
          sourceRefs: [],
        })) as any,
      findDocumentByGoogleFile: (async () => null) as any,
      importGoogleNativeFile: (async () => ({
        kind: 'doc',
        title: 'Imported document',
        model: createDefaultDocumentModel('doc'),
        providerVersion: '4',
      })) as any,
      linkGoogleDocument: (async () => ({ ok: false, code: 'ALREADY_LINKED' })) as any,
    });

    await expect(
      runTool(googleFileImport.handler, {
        connectionId: 'google-1',
        fileId: 'already-linked',
        mimeType: 'application/vnd.google-apps.document',
        webUrl: undefined,
      }),
    ).rejects.toThrow('already linked');
    expect(archive).toHaveBeenCalledWith('test_user_tools', 'orphan-candidate');
  });
});
