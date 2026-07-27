import { describe, expect, test } from 'bun:test';
import { exportDocument } from '../lib/documents/export';
import { googleProviderVersionChanged } from '../lib/documents/google';
import {
  type AlbatrossDocumentRecord,
  createDefaultDocumentModel,
  type DocumentKind,
  documentModelText,
  parseDocumentModel,
} from '../lib/documents/model';

function record(kind: DocumentKind, model = createDefaultDocumentModel(kind)): AlbatrossDocumentRecord {
  return {
    documentId: `document_${kind}`,
    kind,
    title: `Test ${kind}`,
    model,
    currentRevision: 1,
    sourceRefs: [],
    createdAt: Date.UTC(2026, 6, 27),
    updatedAt: Date.UTC(2026, 6, 27),
  };
}

describe('canonical Albatross documents', () => {
  test('creates valid editable defaults for documents, spreadsheets, and presentations', () => {
    for (const kind of ['doc', 'sheet', 'deck'] as const) {
      const model = createDefaultDocumentModel(kind, `seed_${kind}`);
      expect(parseDocumentModel(model, kind)).toEqual(model);
      expect(model.kind).toBe(kind);
    }
  });

  test('rejects a model whose kind does not match the file contract', () => {
    expect(() => parseDocumentModel(createDefaultDocumentModel('sheet'), 'doc')).toThrow(
      'Expected a doc model',
    );
  });

  test('projects each editor model into grounded text for AI context', () => {
    expect(
      documentModelText({
        kind: 'doc',
        version: 1,
        blocks: [
          { id: 'h', type: 'heading', level: 1, text: 'Vendor decision' },
          { id: 'p', type: 'paragraph', text: 'Choose Acme.' },
        ],
      }),
    ).toBe('Vendor decision\nChoose Acme.');
    expect(
      documentModelText({
        kind: 'sheet',
        version: 1,
        activeSheetId: 's',
        sheets: [
          {
            id: 's',
            name: 'Comparison',
            rowCount: 10,
            columnCount: 4,
            cells: { A1: { value: 'Vendor' }, B2: { formula: 'SUM(B3:B8)' } },
          },
        ],
      }),
    ).toContain('B2: SUM(B3:B8)');
    expect(
      documentModelText({
        kind: 'deck',
        version: 1,
        activeSlideId: 'slide',
        slides: [
          {
            id: 'slide',
            title: 'Recommendation',
            notes: 'Cite the decision memo.',
            elements: [
              {
                id: 'title',
                type: 'text',
                role: 'title',
                x: 10,
                y: 10,
                width: 80,
                height: 15,
                text: 'Choose Acme',
              },
            ],
          },
        ],
      }),
    ).toContain('Choose Acme');
  });

  test('exports real Office Open XML files for every editor kind', async () => {
    const doc = await exportDocument(
      record('doc', {
        kind: 'doc',
        version: 1,
        blocks: [
          { id: 'h', type: 'heading', level: 1, text: 'Launch plan' },
          { id: 'b', type: 'bullet', text: 'Ship the editor' },
        ],
      }),
    );
    const sheet = await exportDocument(
      record('sheet', {
        kind: 'sheet',
        version: 1,
        activeSheetId: 's',
        sheets: [
          {
            id: 's',
            name: 'Model',
            rowCount: 20,
            columnCount: 8,
            cells: {
              A1: { value: 'Revenue' },
              B2: { value: 42, format: 'currency' },
              B3: { formula: 'SUM(B2:B2)' },
            },
          },
        ],
      }),
    );
    const deck = await exportDocument(
      record('deck', {
        kind: 'deck',
        version: 1,
        activeSlideId: 'slide',
        slides: [
          {
            id: 'slide',
            title: 'Decision',
            notes: 'Explain the tradeoff.',
            elements: [
              {
                id: 'title',
                type: 'text',
                role: 'title',
                x: 10,
                y: 20,
                width: 80,
                height: 20,
                text: 'Decision',
              },
            ],
          },
        ],
      }),
    );

    expect([doc.extension, sheet.extension, deck.extension]).toEqual(['docx', 'xlsx', 'pptx']);
    for (const file of [doc, sheet, deck]) {
      expect(file.bytes.byteLength).toBeGreaterThan(1_000);
      expect(Array.from(file.bytes.slice(0, 2))).toEqual([0x50, 0x4b]);
      expect(file.contentType).toContain('officedocument');
    }
  }, 20_000);

  test('provider version checks protect Google-side edits without blocking legacy links', () => {
    expect(googleProviderVersionChanged('17', '18')).toBe(true);
    expect(googleProviderVersionChanged('18', '18')).toBe(false);
    expect(googleProviderVersionChanged(undefined, '18')).toBe(false);
  });
});
