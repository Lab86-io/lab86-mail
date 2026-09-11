import { afterEach, expect, mock, test } from 'bun:test';
import {
  __setGoogleDocumentDepsForTest,
  publishDocumentToGoogle,
  updateGoogleNativeFile,
} from '../lib/documents/google';
import { GoogleDocumentFidelityError } from '../lib/documents/google-fidelity';
import {
  ENGINE_GOOGLE_PUBLISH_LIMITATION,
  googleModelWriteLimitation,
  RICH_DECK_GOOGLE_PUBLISH_LIMITATION,
  RICH_DOCUMENT_GOOGLE_PUBLISH_LIMITATION,
} from '../lib/documents/google-write-policy';
import { documentError } from '../lib/documents/http';
import type { AlbatrossDocumentRecord } from '../lib/documents/model';
import {
  DocumentTooLargeError,
  ODOO_SPREADSHEET_VERSION,
  type SheetWorkbookModel,
} from '../lib/documents/sheet-workbook';

const model: SheetWorkbookModel = {
  kind: 'sheet',
  version: 2,
  engine: 'o-spreadsheet',
  engineVersion: ODOO_SPREADSHEET_VERSION,
  workbook: {
    version: 1,
    sheets: [{ id: 'sheet', name: 'Plan', colNumber: 26, rowNumber: 100, cells: { A1: '=2+2' } }],
    styles: { 1: { bold: true } },
  },
};

afterEach(() => __setGoogleDocumentDepsForTest());

test('full Odoo workbooks cannot be silently published or synced as a values-only Google copy', async () => {
  const calls = mock(() => {
    throw new Error('Provider access must not run');
  });
  __setGoogleDocumentDepsForTest({
    fetch: calls as any,
    getCloudFileAccess: calls as any,
    listCloudFileConnections: calls as any,
    linkGoogleDocument: calls as any,
  });
  const document: AlbatrossDocumentRecord = {
    documentId: 'workbook',
    kind: 'sheet',
    title: 'Plan',
    model,
    currentRevision: 3,
    sourceRefs: [],
    createdAt: 1,
    updatedAt: 2,
  };
  for (const google of [
    undefined,
    {
      connectionId: 'drive',
      fileId: 'existing',
      mimeType: 'application/vnd.google-apps.spreadsheet',
      syncedRevision: 2,
      providerVersion: '2',
    },
  ]) {
    await expect(
      publishDocumentToGoogle({ userId: 'owner', document: { ...document, google } }),
    ).rejects.toThrow(ENGINE_GOOGLE_PUBLISH_LIMITATION);
  }
  await expect(
    updateGoogleNativeFile({
      userId: 'owner',
      connectionId: 'drive',
      fileId: 'existing',
      kind: 'sheet',
      title: 'Plan',
      model,
      expectedProviderVersion: '2',
    }),
  ).rejects.toBeInstanceOf(GoogleDocumentFidelityError);
  expect(calls).not.toHaveBeenCalled();
  expect(model.workbook.styles).toEqual({ 1: { bold: true } });
});

test('document-create size failures return an actionable 413', async () => {
  const response = documentError(new DocumentTooLargeError(950_000));
  expect(response.status).toBe(413);
  expect(await response.json()).toMatchObject({ ok: false, error: expect.stringContaining('limit') });
});

test('rich document formatting is never silently discarded by Google publication or writeback', async () => {
  const calls = mock(() => {
    throw new Error('Provider access must not run');
  });
  __setGoogleDocumentDepsForTest({
    fetch: calls as any,
    getCloudFileAccess: calls as any,
    listCloudFileConnections: calls as any,
    linkGoogleDocument: calls as any,
  });
  const rich = {
    kind: 'doc',
    version: 1,
    blocks: [{ id: 'p1', type: 'paragraph', text: 'Important', runs: [{ text: 'Important', bold: true }] }],
  };
  await expect(
    publishDocumentToGoogle({
      userId: 'owner',
      document: {
        documentId: 'rich',
        kind: 'doc',
        title: 'Rich',
        model: rich as any,
        currentRevision: 1,
        sourceRefs: [],
        createdAt: 1,
        updatedAt: 1,
      },
    }),
  ).rejects.toThrow(RICH_DOCUMENT_GOOGLE_PUBLISH_LIMITATION);
  await expect(
    updateGoogleNativeFile({
      userId: 'owner',
      connectionId: 'drive',
      fileId: 'rich',
      kind: 'doc',
      title: 'Rich',
      model: rich,
      expectedProviderVersion: '2',
    }),
  ).rejects.toThrow(RICH_DOCUMENT_GOOGLE_PUBLISH_LIMITATION);
  expect(calls).not.toHaveBeenCalled();
});

test('shared Google policy blocks presentation semantics that the writer cannot preserve', async () => {
  const plain = {
    kind: 'deck',
    version: 1,
    slides: [
      {
        id: 'slide',
        title: 'Plan',
        elements: [
          { id: 'title', type: 'text', x: 5, y: 5, width: 80, height: 20, text: 'Plan', color: '#112233' },
        ],
      },
    ],
  };
  expect(googleModelWriteLimitation(plain)).toBeNull();
  for (const slide of [
    { ...plain.slides[0], notes: 'Private speaker notes' },
    { ...plain.slides[0], background: '#001122' },
    { ...plain.slides[0], elements: [{ ...plain.slides[0].elements[0], fill: '#001122' }] },
    { ...plain.slides[0], elements: [{ ...plain.slides[0].elements[0], type: 'shape', color: '#001122' }] },
    { ...plain.slides[0], elements: [{ ...plain.slides[0].elements[0], color: '#fff' }] },
  ]) {
    const model = { ...plain, slides: [slide] };
    expect(googleModelWriteLimitation(model)).toBe(RICH_DECK_GOOGLE_PUBLISH_LIMITATION);
    const calls = mock(() => {
      throw new Error('Provider access must not run');
    });
    __setGoogleDocumentDepsForTest({
      getCloudFileAccess: calls as any,
      listCloudFileConnections: calls as any,
    });
    await expect(
      publishDocumentToGoogle({
        userId: 'owner',
        document: {
          documentId: 'slides',
          kind: 'deck',
          title: 'Slides',
          model: model as any,
          currentRevision: 1,
          sourceRefs: [],
          createdAt: 1,
          updatedAt: 1,
        },
      }),
    ).rejects.toThrow(RICH_DECK_GOOGLE_PUBLISH_LIMITATION);
    expect(calls).not.toHaveBeenCalled();
  }
});
