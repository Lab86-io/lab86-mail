import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import {
  __setDocumentAiDepsForTest,
  DocumentGenerationError,
  generateDocumentProposal,
} from '../lib/documents/ai';
import {
  __setGoogleDocumentDepsForTest,
  GoogleDocumentConflictError,
  publishDocumentToGoogle,
  updateGoogleNativeFile,
} from '../lib/documents/google';
import { __setGoogleImportDepsForTest, importGoogleNativeFile } from '../lib/documents/google-import';
import {
  type AlbatrossDocumentModel,
  type AlbatrossDocumentRecord,
  createDefaultDocumentModel,
  type DocumentKind,
} from '../lib/documents/model';
import {
  __setDocumentServiceDepsForTest,
  applyDocumentSuggestion,
  archiveDocument,
  createAndLinkGoogleDocument,
  createDocument,
  createDocumentSuggestion,
  findDocumentByGoogleFile,
  getDocument,
  linkGoogleDocument,
  listDocuments,
  resolveDocumentSuggestion,
  updateDocument,
} from '../lib/documents/service';
import { api } from '../lib/hosted/convex';

const documentsApi = (api as any).documents;

function documentRecord(
  kind: DocumentKind,
  model: AlbatrossDocumentModel = createDefaultDocumentModel(kind, `seed-${kind}`),
): AlbatrossDocumentRecord {
  return {
    documentId: `document-${kind}`,
    kind,
    title: `Test ${kind}`,
    model,
    currentRevision: 3,
    sourceRefs: [],
    createdAt: 1_000,
    updatedAt: 2_000,
  };
}

afterEach(() => {
  __setDocumentAiDepsForTest();
  __setDocumentServiceDepsForTest();
  __setGoogleImportDepsForTest();
  __setGoogleDocumentDepsForTest();
});

describe('document AI proposal service', () => {
  test('generates validated doc, sheet, and deck proposals with bounded context', async () => {
    const generated = mock(async (input: any) => {
      const kind = input.prompt.includes('spreadsheet')
        ? 'sheet'
        : input.prompt.includes('presentation')
          ? 'deck'
          : 'doc';
      return {
        object: {
          title: `${kind} proposal`,
          summary: `Prepared ${kind}`,
          model: createDefaultDocumentModel(kind, `proposal-${kind}`),
        },
      };
    });
    __setDocumentAiDepsForTest({ generateObjectForCurrentUser: generated as any });

    const doc = await generateDocumentProposal({
      userId: 'user-1',
      userEmail: 'person@example.test',
      userName: 'Person',
      kind: 'doc',
      instruction: `  Rewrite this memo ${'x'.repeat(21_000)}  `,
      current: documentRecord('doc') as any,
      sourceContext: `  Grounded notes ${'y'.repeat(41_000)}  `,
    });
    const sheet = await generateDocumentProposal({
      userId: 'user-1',
      kind: 'sheet',
      instruction: 'Build a model spreadsheet',
    });
    const deck = await generateDocumentProposal({
      userId: 'user-1',
      kind: 'deck',
      instruction: 'Create a launch presentation',
    });

    expect([doc.model.kind, sheet.model.kind, deck.model.kind]).toEqual(['doc', 'sheet', 'deck']);
    expect(generated.mock.calls[0][0]).toMatchObject({
      feature: 'document_suggestion',
      speed: 'primary',
      maxOutputTokens: 14_000,
    });
    expect(generated.mock.calls[0][0].system).toContain('structured blocks');
    expect(generated.mock.calls[1][0].system).toContain('A1 notation');
    expect(generated.mock.calls[2][0].system).toContain('16:9 slides');
    expect(generated.mock.calls[0][0].prompt.length).toBeLessThan(181_000);
  });

  test('rejects model output that does not match the requested document kind', async () => {
    __setDocumentAiDepsForTest({
      generateObjectForCurrentUser: (async () => ({
        object: {
          title: 'Wrong model',
          summary: 'Invalid output',
          model: createDefaultDocumentModel('sheet'),
        },
      })) as any,
    });
    await expect(
      generateDocumentProposal({
        userId: 'user-1',
        kind: 'doc',
        instruction: 'Write a memo',
      }),
    ).rejects.toBeInstanceOf(DocumentGenerationError);
  });
});

describe('document persistence service', () => {
  test('creates defaults, normalizes titles, and lists parsed records', async () => {
    const mutation = mock(async (_reference: unknown, input: any) => ({
      documentId: input.documentId,
      kind: input.kind,
      title: input.title,
      model: input.model,
      currentRevision: 1,
      sourceRefs: input.sourceRefs,
      createdAt: 1,
      updatedAt: 1,
    }));
    const query = mock(async () => [documentRecord('doc')]);
    __setDocumentServiceDepsForTest({
      convexMutation: mutation as any,
      convexQuery: query as any,
      randomUUID: (() => 'fixed-document-id') as any,
    });

    const created = await createDocument({
      userId: 'user-1',
      kind: 'sheet',
      title: '   ',
      reason: 'test',
    });
    expect(created).toMatchObject({
      documentId: 'fixed-document-id',
      kind: 'sheet',
      title: 'Untitled',
    });
    expect(created.model.kind).toBe('sheet');
    await expect(listDocuments({ userId: 'user-1', kind: 'doc', limit: 5 })).resolves.toEqual([
      documentRecord('doc'),
    ]);
  });

  test('reads suggestions, provider links, updates, archives, and resolves suggestions', async () => {
    const doc = documentRecord('doc');
    const suggestion = {
      suggestionId: 'suggestion-1',
      documentId: doc.documentId,
      title: 'Rewrite',
      description: 'Clearer prose',
      proposedModel: createDefaultDocumentModel('doc', 'proposal'),
      sourceRefs: [],
      status: 'proposed' as const,
      createdAt: 3_000,
    };
    const queryResults = [{ ...doc, suggestions: [suggestion] }, doc, 'doc', null];
    const query = mock(async () => queryResults.shift() as any);
    const mutation = mock(async (_reference: unknown, input: any) => {
      if (input.expectedRevision !== undefined) {
        return {
          ok: true,
          document: {
            ...doc,
            title: input.title || doc.title,
            model: input.model || doc.model,
            currentRevision: input.expectedRevision + 1,
          },
        };
      }
      return { ok: true, createdAt: 4_000 };
    });
    __setDocumentServiceDepsForTest({
      convexMutation: mutation as any,
      convexQuery: query as any,
      randomUUID: (() => 'suggestion-fixed') as any,
    });

    const found = await getDocument('user-1', doc.documentId);
    expect(found?.suggestions[0].proposedModel.kind).toBe('doc');
    await expect(
      findDocumentByGoogleFile({
        userId: 'user-1',
        connectionId: 'google-1',
        fileId: 'file-1',
      }),
    ).resolves.toMatchObject({ documentId: doc.documentId });
    await expect(
      updateDocument({
        userId: 'user-1',
        documentId: doc.documentId,
        expectedRevision: 3,
        title: '  Revised title  ',
        model: createDefaultDocumentModel('doc', 'revised'),
        actor: 'ai',
      }),
    ).resolves.toMatchObject({
      ok: true,
      document: { title: 'Revised title', currentRevision: 4 },
    });
    await expect(
      updateDocument({
        userId: 'user-1',
        documentId: doc.documentId,
        expectedRevision: 4,
        title: 'Title only',
      }),
    ).resolves.toMatchObject({ ok: true });
    await updateDocument({
      userId: 'user-1',
      documentId: doc.documentId,
      expectedRevision: 4,
      title: '   ',
    });
    expect(mutation.mock.calls[2][1].title).toBe('Untitled');
    await expect(
      updateDocument({
        userId: 'user-1',
        documentId: doc.documentId,
        expectedRevision: 4,
        model: createDefaultDocumentModel('doc'),
      }),
    ).resolves.toEqual({ ok: false, code: 'NOT_FOUND' });

    const createdSuggestion = await createDocumentSuggestion({
      userId: 'user-1',
      documentId: doc.documentId,
      title: 'Proposal',
      description: 'Description',
      proposedModel: doc.model,
    });
    expect(createdSuggestion).toMatchObject({ ok: true, suggestionId: 'suggestion-fixed' });
    await archiveDocument('user-1', doc.documentId);
    await resolveDocumentSuggestion({
      userId: 'user-1',
      documentId: doc.documentId,
      suggestionId: 'suggestion-fixed',
      status: 'applied',
    });
    await linkGoogleDocument({
      userId: 'user-1',
      documentId: doc.documentId,
      connectionId: 'google-1',
      fileId: 'file-1',
      mimeType: 'application/vnd.google-apps.document',
      syncedRevision: 4,
    });
    expect(mutation.mock.calls.map(([reference]) => getFunctionName(reference as any))).toEqual([
      getFunctionName(documentsApi.update),
      getFunctionName(documentsApi.update),
      getFunctionName(documentsApi.update),
      getFunctionName(documentsApi.createSuggestion),
      getFunctionName(documentsApi.archive),
      getFunctionName(documentsApi.resolveSuggestion),
      getFunctionName(documentsApi.linkGoogleFile),
    ]);
  });

  test('archives a newly created Google import and reports failed compensation', async () => {
    const warning = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const document = documentRecord('doc');
      const mutation = mock(async (reference: unknown, input: any) => {
        const name = getFunctionName(reference as any);
        if (name === getFunctionName(documentsApi.create)) {
          return { ...document, documentId: input.documentId, currentRevision: 1 };
        }
        if (name === getFunctionName(documentsApi.linkGoogleFile)) {
          return { ok: false, code: 'ALREADY_LINKED', documentId: 'canonical-document' };
        }
        if (name === getFunctionName(documentsApi.archive)) throw new Error('archive unavailable');
        throw new Error(`Unexpected mutation: ${name}`);
      });
      __setDocumentServiceDepsForTest({
        convexMutation: mutation as any,
        randomUUID: (() => 'orphan-document') as any,
      });

      const result = await createAndLinkGoogleDocument({
        userId: 'user-1',
        kind: 'doc',
        title: 'Imported document',
        model: document.model,
        sourceRefs: [{ kind: 'google_drive', id: 'file-1' }],
        reason: 'google_import',
        connectionId: 'google-1',
        fileId: 'file-1',
        mimeType: 'application/vnd.google-apps.document',
        providerVersion: '4',
      });

      expect(result.linked).toMatchObject({
        ok: false,
        code: 'ALREADY_LINKED',
        documentId: 'canonical-document',
      });
      expect(mutation.mock.calls.map(([reference]) => getFunctionName(reference as any))).toEqual([
        getFunctionName(documentsApi.create),
        getFunctionName(documentsApi.linkGoogleFile),
        getFunctionName(documentsApi.archive),
      ]);
      expect(warning).toHaveBeenCalledWith(
        '[google-file-import] failed to archive orphaned document',
        'orphan-document',
        expect.any(Error),
      );
    } finally {
      warning.mockRestore();
    }
  });

  test('returns null for a missing document and provider file', async () => {
    __setDocumentServiceDepsForTest({
      convexQuery: (async () => null) as any,
    });
    await expect(getDocument('user-1', 'missing')).resolves.toBeNull();
    await expect(
      findDocumentByGoogleFile({
        userId: 'user-1',
        connectionId: 'google-1',
        fileId: 'missing',
      }),
    ).resolves.toBeNull();
  });

  test('applies a suggestion through the single transactional service mutation', async () => {
    const mutation = mock(async (_reference: unknown, input: any) => ({
      ok: true,
      document: {
        ...documentRecord('doc'),
        title: 'Applied title',
        currentRevision: input.expectedRevision + 1,
      },
    }));
    __setDocumentServiceDepsForTest({ convexMutation: mutation as any });

    await expect(
      applyDocumentSuggestion({
        userId: 'user-1',
        documentId: 'document-doc',
        suggestionId: 'suggestion-1',
        expectedRevision: 3,
      }),
    ).resolves.toMatchObject({
      ok: true,
      document: { title: 'Applied title', currentRevision: 4 },
    });
    expect(mutation.mock.calls[0][1]).toEqual({
      userId: 'user-1',
      documentId: 'document-doc',
      suggestionId: 'suggestion-1',
      expectedRevision: 3,
    });
  });
});

describe('Google native import', () => {
  function installImportFetch() {
    const fetchMock = mock(async (url: string | URL | Request) => {
      const endpoint = String(url);
      if (endpoint.includes('drive/v3/files/')) {
        return Response.json({
          name: endpoint.includes('sheet') ? 'Imported sheet' : 'Imported file',
          webViewLink: 'https://drive.google.com/open',
          version: 12,
        });
      }
      if (endpoint.includes('docs.googleapis.com')) {
        return Response.json({
          title: 'Imported document',
          body: {
            content: [
              {
                paragraph: {
                  paragraphStyle: { namedStyleType: 'HEADING_1' },
                  elements: [{ textRun: { content: 'Heading\n' } }],
                },
              },
              {
                paragraph: {
                  bullet: {},
                  elements: [{ textRun: { content: 'Bullet\n' } }],
                },
              },
              { paragraph: { elements: [{ textRun: { content: '\n' } }] } },
            ],
          },
        });
      }
      if (endpoint.includes('values:batchGet')) {
        return Response.json({
          valueRanges: [
            {
              values: [
                ['Label', 42, true, ''],
                ['Formula', '=SUM(B1:B1)'],
              ],
            },
          ],
        });
      }
      if (endpoint.includes('sheets.googleapis.com') && endpoint.includes('sheets.properties')) {
        return Response.json({
          sheets: [
            {
              properties: {
                sheetId: 7,
                title: "O'Reilly",
                gridProperties: { rowCount: 20, columnCount: 8 },
              },
            },
          ],
        });
      }
      if (endpoint.includes('sheets.googleapis.com')) {
        return Response.json({ properties: { title: 'Imported sheet' } });
      }
      if (endpoint.includes('slides.googleapis.com')) {
        return Response.json({
          title: 'Imported deck',
          slides: [
            {
              objectId: 'slide-1',
              pageElements: [
                {
                  objectId: 'title-1',
                  shape: {
                    placeholder: { type: 'TITLE' },
                    text: { textElements: [{ textRun: { content: 'Deck title\n' } }] },
                  },
                  size: {
                    width: { magnitude: 9_144_000, unit: 'EMU' },
                    height: { magnitude: 1_270_000, unit: 'EMU' },
                  },
                  transform: {
                    translateX: 72,
                    translateY: 36,
                    scaleX: 1,
                    scaleY: 1,
                    unit: 'PT',
                  },
                },
                { objectId: 'ignored-image' },
              ],
            },
          ],
        });
      }
      throw new Error(`Unexpected Google endpoint: ${endpoint}`);
    });
    __setGoogleImportDepsForTest({
      getCloudFileAccess: (async () => ({
        connection: {
          connectionId: 'google-1',
          provider: 'google_drive',
          status: 'connected',
          scopes: [],
        },
        accessToken: 'access-token',
      })) as any,
      fetch: fetchMock as any,
    });
    return fetchMock;
  }

  test('imports editable Google Docs, Sheets, and Slides models', async () => {
    installImportFetch();
    const doc = await importGoogleNativeFile({
      userId: 'user-1',
      connectionId: 'google-1',
      fileId: 'doc-file',
      mimeType: 'application/vnd.google-apps.document',
    });
    const sheet = await importGoogleNativeFile({
      userId: 'user-1',
      connectionId: 'google-1',
      fileId: 'sheet-file',
      mimeType: 'application/vnd.google-apps.spreadsheet',
    });
    const deck = await importGoogleNativeFile({
      userId: 'user-1',
      connectionId: 'google-1',
      fileId: 'deck-file',
      mimeType: 'application/vnd.google-apps.presentation',
    });

    expect(doc.model.kind).toBe('doc');
    if (doc.model.kind !== 'doc') throw new Error('Expected imported doc model.');
    expect(doc.model.blocks.slice(0, 2)).toEqual([
      expect.objectContaining({ type: 'heading', level: 1, text: 'Heading' }),
      expect.objectContaining({ type: 'bullet', text: 'Bullet' }),
    ]);
    expect(sheet.model).toMatchObject({
      kind: 'sheet',
      sheets: [
        {
          name: "O'Reilly",
          cells: {
            A1: { value: 'Label' },
            B1: { value: 42 },
            B2: { formula: 'SUM(B1:B1)' },
          },
        },
      ],
    });
    expect(deck.model).toMatchObject({
      kind: 'deck',
      slides: [{ title: 'Deck title', elements: [{ role: 'title', text: 'Deck title' }] }],
    });
    expect(doc.providerVersion).toBe('12');
  });

  test('creates safe empty models and maps provider access failures', async () => {
    __setGoogleImportDepsForTest({
      getCloudFileAccess: (async () => ({
        connection: {
          connectionId: 'google-1',
          provider: 'google_drive',
          status: 'connected',
          scopes: [],
        },
        accessToken: 'access',
      })) as any,
      fetch: (async (url: string | URL | Request) => {
        const endpoint = String(url);
        if (endpoint.includes('drive/v3')) return Response.json({ name: 'Empty', version: '1' });
        if (endpoint.includes('docs.googleapis.com')) return Response.json({ body: {} });
        return Response.json({});
      }) as any,
    });
    const empty = await importGoogleNativeFile({
      userId: 'user-1',
      connectionId: 'google-1',
      fileId: 'empty-doc',
      mimeType: 'application/vnd.google-apps.document',
    });
    expect(empty.model.kind === 'doc' && empty.model.blocks).toHaveLength(1);

    __setGoogleImportDepsForTest({
      getCloudFileAccess: (async () => null) as any,
    });
    await expect(
      importGoogleNativeFile({
        userId: 'user-1',
        connectionId: 'google-1',
        fileId: 'file',
        mimeType: 'application/vnd.google-apps.document',
      }),
    ).rejects.toThrow('Google Drive connection not found');
    await expect(
      importGoogleNativeFile({
        userId: 'user-1',
        connectionId: 'google-1',
        fileId: 'file',
        mimeType: 'application/pdf',
      }),
    ).rejects.toThrow('Only Google Docs, Sheets, and Slides');

    __setGoogleImportDepsForTest({
      getCloudFileAccess: (async () => ({
        connection: {
          connectionId: 'google-1',
          provider: 'google_drive',
          status: 'connected',
          scopes: [],
        },
        accessToken: 'access',
      })) as any,
      fetch: (async () => Response.json({ error: {} }, { status: 403 })) as any,
    });
    await expect(
      importGoogleNativeFile({
        userId: 'user-1',
        connectionId: 'google-1',
        fileId: 'forbidden',
        mimeType: 'application/vnd.google-apps.document',
      }),
    ).rejects.toThrow('missing or expired');
  });

  test('bounds oversized Google grids, drops excess cells, and truncates slide titles', async () => {
    const oversizedRow = Array.from({ length: 501 }, (_, index) => `value-${index + 1}`);
    __setGoogleImportDepsForTest({
      getCloudFileAccess: (async () => ({
        connection: {
          connectionId: 'google-1',
          provider: 'google_drive',
          status: 'connected',
          scopes: [],
        },
        accessToken: 'access',
      })) as any,
      fetch: (async (url: string | URL | Request) => {
        const endpoint = String(url);
        if (endpoint.includes('drive/v3/files/')) {
          return Response.json({ name: 'Oversized', version: '1' });
        }
        if (endpoint.includes('values:batchGet')) {
          return Response.json({ valueRanges: [{ values: [oversizedRow] }] });
        }
        if (endpoint.includes('sheets.googleapis.com')) {
          return Response.json({
            properties: { title: 'Oversized sheet' },
            sheets: [
              {
                properties: {
                  sheetId: 1,
                  title: 'Large',
                  gridProperties: { rowCount: 1_000_000, columnCount: 18_278 },
                },
              },
            ],
          });
        }
        if (endpoint.includes('slides.googleapis.com')) {
          return Response.json({
            title: 'Long deck',
            slides: [
              {
                objectId: 'slide',
                pageElements: [
                  {
                    objectId: 'title',
                    shape: {
                      placeholder: { type: 'TITLE' },
                      text: { textElements: [{ textRun: { content: `${'T'.repeat(600)}\n` } }] },
                    },
                  },
                ],
              },
            ],
          });
        }
        throw new Error(`Unexpected endpoint: ${endpoint}`);
      }) as any,
    });

    const sheet = await importGoogleNativeFile({
      userId: 'user-1',
      connectionId: 'google-1',
      fileId: 'sheet-file',
      mimeType: 'application/vnd.google-apps.spreadsheet',
    });
    expect(sheet.model.kind).toBe('sheet');
    if (sheet.model.kind !== 'sheet') throw new Error('Expected a sheet.');
    expect(sheet.model.sheets[0]).toMatchObject({ rowCount: 10_000, columnCount: 500 });
    expect(Object.keys(sheet.model.sheets[0].cells)).toHaveLength(500);
    expect(sheet.model.sheets[0].cells.SG1).toBeUndefined();

    const deck = await importGoogleNativeFile({
      userId: 'user-1',
      connectionId: 'google-1',
      fileId: 'deck-file',
      mimeType: 'application/vnd.google-apps.presentation',
    });
    expect(deck.model.kind).toBe('deck');
    if (deck.model.kind !== 'deck') throw new Error('Expected a deck.');
    expect(deck.model.slides[0].title).toHaveLength(500);
  });

  test('keeps sheet values aligned when metadata contains an untitled tab', async () => {
    __setGoogleImportDepsForTest({
      getCloudFileAccess: (async () => ({
        connection: {
          connectionId: 'google-1',
          provider: 'google_drive',
          status: 'connected',
          scopes: [],
        },
        accessToken: 'access',
      })) as any,
      fetch: (async (url: string | URL | Request) => {
        const endpoint = String(url);
        if (endpoint.includes('drive/v3/files/')) {
          return Response.json({ name: 'Mixed tabs', version: '1' });
        }
        if (endpoint.includes('values:batchGet')) {
          return Response.json({ valueRanges: [{ values: [['Second tab value']] }] });
        }
        if (endpoint.includes('sheets.properties')) {
          return Response.json({
            properties: { title: 'Mixed tabs' },
            sheets: [
              {
                properties: {
                  sheetId: 1,
                  title: '',
                  gridProperties: { rowCount: 10, columnCount: 3 },
                },
              },
              {
                properties: {
                  sheetId: 2,
                  title: 'Second',
                  gridProperties: { rowCount: 10, columnCount: 3 },
                },
              },
            ],
          });
        }
        if (endpoint.includes('sheets.googleapis.com')) {
          return Response.json({ properties: { title: 'Mixed tabs' } });
        }
        throw new Error(`Unexpected endpoint: ${endpoint}`);
      }) as any,
    });

    const imported = await importGoogleNativeFile({
      userId: 'user-1',
      connectionId: 'google-1',
      fileId: 'mixed-tabs',
      mimeType: 'application/vnd.google-apps.spreadsheet',
    });
    expect(imported.model.kind).toBe('sheet');
    if (imported.model.kind !== 'sheet') throw new Error('Expected a sheet.');
    expect(imported.model.sheets[0].cells).toEqual({});
    expect(imported.model.sheets[1].cells.A1).toEqual({ value: 'Second tab value' });
  });

  test('maps a timed-out Google import to a retryable failure', async () => {
    __setGoogleImportDepsForTest({
      getCloudFileAccess: (async () => ({
        connection: {
          connectionId: 'google-1',
          provider: 'google_drive',
          status: 'connected',
          scopes: [],
        },
        accessToken: 'access',
      })) as any,
      fetch: (async () => {
        throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
      }) as any,
    });
    await expect(
      importGoogleNativeFile({
        userId: 'user-1',
        connectionId: 'google-1',
        fileId: 'slow-doc',
        mimeType: 'application/vnd.google-apps.document',
      }),
    ).rejects.toThrow('timed out');
  });
});

describe('Google document publishing', () => {
  function installPublisher() {
    const linked = mock(async () => ({ ok: true }));
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const endpoint = String(url);
      requests.push({ url: endpoint, init });
      if (endpoint === 'https://docs.googleapis.com/v1/documents' && init?.method === 'POST') {
        return Response.json({ documentId: 'created-doc' });
      }
      if (endpoint === 'https://sheets.googleapis.com/v4/spreadsheets' && init?.method === 'POST') {
        return Response.json({ spreadsheetId: 'created-sheet' });
      }
      if (endpoint === 'https://slides.googleapis.com/v1/presentations' && init?.method === 'POST') {
        return Response.json({ presentationId: 'created-deck' });
      }
      if (endpoint.includes('docs.googleapis.com') && endpoint.includes('fields=')) {
        return Response.json({
          revisionId: 'docs-revision-7',
          body: { content: [{ endIndex: 8 }] },
        });
      }
      if (endpoint.includes('sheets.googleapis.com') && endpoint.includes('fields=sheets')) {
        return Response.json({
          sheets: [
            { properties: { sheetId: 0, title: 'Old' } },
            { properties: { sheetId: 9, title: 'Remove' } },
          ],
        });
      }
      if (endpoint.includes('slides.googleapis.com') && endpoint.includes('fields=slides')) {
        return Response.json({ slides: [{ objectId: 'old-slide' }] });
      }
      if (endpoint.includes('drive/v3/files/')) {
        return Response.json({
          webViewLink: 'https://drive.google.com/open',
          version: '9',
        });
      }
      return Response.json({});
    });
    __setGoogleDocumentDepsForTest({
      getCloudFileAccess: (async () => ({
        connection: {
          connectionId: 'google-1',
          provider: 'google_drive',
          status: 'connected',
          scopes: [],
        },
        accessToken: 'access-token',
      })) as any,
      listCloudFileConnections: (async () => [
        {
          connectionId: 'google-1',
          provider: 'google_drive',
          status: 'connected',
          scopes: [],
        },
      ]) as any,
      linkGoogleDocument: linked as any,
      fetch: fetchMock as any,
    });
    return { linked, requests };
  }

  test('creates and fully syncs Docs, Sheets, and Slides', async () => {
    const { linked, requests } = installPublisher();
    const doc = documentRecord('doc', {
      kind: 'doc',
      version: 1,
      blocks: [
        { id: 'h', type: 'heading', level: 1, text: 'Heading' },
        { id: 'n', type: 'numbered', text: 'First' },
        { id: 'b', type: 'bullet', text: 'Bullet' },
        { id: 'q', type: 'quote', text: 'Quote' },
      ],
    });
    const sheet = documentRecord('sheet', {
      kind: 'sheet',
      version: 1,
      activeSheetId: 'one',
      sheets: [
        {
          id: 'one',
          name: "Plan's",
          rowCount: 20,
          columnCount: 5,
          cells: {
            A1: { value: 'Label' },
            B2: { value: 42 },
            C3: { formula: '=SUM(B2:B2)' },
            invalid: { value: 'ignored' },
            A9999999: { value: 'oversized-row' },
            ZZZ1: { value: 'oversized-column' },
          },
        },
        { id: 'two', name: 'Second', rowCount: 5, columnCount: 2, cells: {} },
      ],
    });
    const deck = documentRecord('deck', {
      kind: 'deck',
      version: 1,
      activeSlideId: '1-slide',
      slides: [
        {
          id: '1-slide',
          title: 'Decision',
          elements: [
            {
              id: 'title.one',
              type: 'text',
              role: 'title',
              x: 10,
              y: 10,
              width: 80,
              height: 20,
              text: 'Decision',
              color: '#123456',
            },
            {
              id: 'shape',
              type: 'shape',
              role: 'shape',
              x: 20,
              y: 40,
              width: 30,
              height: 20,
            },
          ],
        },
      ],
    });

    const publishedDoc = await publishDocumentToGoogle({ userId: 'user-1', document: doc });
    const publishedSheet = await publishDocumentToGoogle({
      userId: 'user-1',
      document: sheet,
      connectionId: 'google-1',
    });
    const publishedDeck = await publishDocumentToGoogle({
      userId: 'user-1',
      document: deck,
      connectionId: 'google-1',
    });

    expect([publishedDoc.fileId, publishedSheet.fileId, publishedDeck.fileId]).toEqual([
      'created-doc',
      'created-sheet',
      'created-deck',
    ]);
    expect(linked).toHaveBeenCalledTimes(3);
    expect(requests.some((request) => request.url.includes('documents/created-doc:batchUpdate'))).toBe(true);
    expect(requests.some((request) => request.url.includes('values:batchClear'))).toBe(true);
    expect(requests.some((request) => request.url.includes('presentations/created-deck:batchUpdate'))).toBe(
      true,
    );
    const docBatch = requests.find((request) => request.url.includes('created-doc:batchUpdate'));
    expect(String(docBatch?.init?.body)).toContain('createParagraphBullets');
    expect(JSON.parse(String(docBatch?.init?.body)).writeControl).toEqual({
      requiredRevisionId: 'docs-revision-7',
    });
    const sheetValues = requests.find((request) => request.url.includes('values:batchUpdate'));
    expect(String(sheetValues?.init?.body)).toContain('=SUM(B2:B2)');
    expect(String(sheetValues?.init?.body)).not.toContain('oversized-row');
    expect(String(sheetValues?.init?.body)).not.toContain('oversized-column');
  });

  test('protects provider versions and validates connection selection', async () => {
    const existing = {
      ...documentRecord('doc'),
      google: {
        connectionId: 'google-1',
        fileId: 'existing-doc',
        mimeType: 'application/vnd.google-apps.document',
        providerVersion: '8',
        syncedRevision: 2,
        lastSyncedAt: 1,
      },
    };
    __setGoogleDocumentDepsForTest({
      getCloudFileAccess: (async () => ({
        connection: {
          connectionId: 'google-1',
          provider: 'google_drive',
          status: 'connected',
          scopes: [],
        },
        accessToken: 'access',
      })) as any,
      fetch: (async () =>
        Response.json({ webViewLink: 'https://drive.google.com/open', version: '9' })) as any,
    });
    await expect(publishDocumentToGoogle({ userId: 'user-1', document: existing })).rejects.toBeInstanceOf(
      GoogleDocumentConflictError,
    );

    __setGoogleDocumentDepsForTest({
      listCloudFileConnections: (async () => []) as any,
    });
    await expect(
      publishDocumentToGoogle({ userId: 'user-1', document: documentRecord('doc') }),
    ).rejects.toThrow('Connect Google Drive');

    __setGoogleDocumentDepsForTest({
      getCloudFileAccess: (async () => ({
        connection: {
          connectionId: 'onedrive-1',
          provider: 'onedrive',
          status: 'connected',
          scopes: [],
        },
        accessToken: 'access',
      })) as any,
    });
    await expect(
      publishDocumentToGoogle({
        userId: 'user-1',
        document: documentRecord('doc'),
        connectionId: 'onedrive-1',
      }),
    ).rejects.toThrow('selected Google Drive connection was not found');
  });

  test('updates a provider-owned Google file in place without linking an Albatross copy', async () => {
    const { linked, requests } = installPublisher();
    const model = createDefaultDocumentModel('doc', 'provider-file');
    const updated = await updateGoogleNativeFile({
      userId: 'user-1',
      connectionId: 'google-1',
      fileId: 'provider-file',
      kind: 'doc',
      title: 'Renamed in place',
      model,
      expectedProviderVersion: '9',
    });

    expect(updated).toMatchObject({
      title: 'Renamed in place',
      providerVersion: '9',
    });
    expect(linked).not.toHaveBeenCalled();
    expect(requests.some((request) => request.url.includes('documents/provider-file:batchUpdate'))).toBe(
      true,
    );
    const rename = requests.find(
      (request) => request.url.includes('/drive/v3/files/provider-file?') && request.init?.method === 'PATCH',
    );
    expect(JSON.parse(String(rename?.init?.body))).toEqual({ name: 'Renamed in place' });

    await expect(
      updateGoogleNativeFile({
        userId: 'user-1',
        connectionId: 'google-1',
        fileId: 'provider-file',
        kind: 'doc',
        title: 'Stale',
        model,
        expectedProviderVersion: '8',
      }),
    ).rejects.toBeInstanceOf(GoogleDocumentConflictError);
  });

  test('maps Google API errors and missing create identifiers', async () => {
    __setGoogleDocumentDepsForTest({
      getCloudFileAccess: (async () => ({
        connection: {
          connectionId: 'google-1',
          provider: 'google_drive',
          status: 'connected',
          scopes: [],
        },
        accessToken: 'access',
      })) as any,
      fetch: (async () => Response.json({ error: { message: 'permission denied' } }, { status: 403 })) as any,
    });
    await expect(
      publishDocumentToGoogle({
        userId: 'user-1',
        document: documentRecord('doc'),
        connectionId: 'google-1',
      }),
    ).rejects.toThrow('missing or expired');

    __setGoogleDocumentDepsForTest({
      getCloudFileAccess: (async () => ({
        connection: {
          connectionId: 'google-1',
          provider: 'google_drive',
          status: 'connected',
          scopes: [],
        },
        accessToken: 'access',
      })) as any,
      fetch: (async () => Response.json({})) as any,
    });
    await expect(
      publishDocumentToGoogle({
        userId: 'user-1',
        document: documentRecord('doc'),
        connectionId: 'google-1',
      }),
    ).rejects.toThrow('without returning its identifier');
  });
});
