import { describe, expect, test } from 'bun:test';
import { documentContentDisposition } from '../app/api/documents/[documentId]/export/route';
import { documentDraftMatchesSave } from '../lib/documents/autosave';
import { exportDocument, presentationColor, uniqueWorksheetName } from '../lib/documents/export';
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
        kind: 'sheet',
        version: 1,
        activeSheetId: 'values',
        sheets: [
          {
            id: 'values',
            name: 'Falsy values',
            rowCount: 2,
            columnCount: 2,
            cells: { A1: { value: 0 }, B1: { value: false } },
          },
        ],
      }),
    ).toContain('A1: 0\nB1: false');
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

  test('autosave only clears dirty state when the saved snapshot is still current', () => {
    const savedModel = createDefaultDocumentModel('doc', 'saved');
    const newerModel = createDefaultDocumentModel('doc', 'newer');
    expect(
      documentDraftMatchesSave(
        { title: 'Decision memo', model: savedModel },
        { title: 'Decision memo', model: savedModel },
      ),
    ).toBe(true);
    expect(
      documentDraftMatchesSave(
        { title: 'Decision memo — latest', model: newerModel },
        { title: 'Decision memo', model: savedModel },
      ),
    ).toBe(false);
  });

  test('sanitizes, bounds, and deduplicates worksheet names case-insensitively', () => {
    const used = new Set<string>();
    expect(uniqueWorksheetName("  'Forecast:*?[]/\\\\'  ", used)).toBe('Forecast');
    expect(uniqueWorksheetName('forecast', used)).toBe('forecast (2)');
    expect(uniqueWorksheetName('A'.repeat(50), used)).toHaveLength(31);
    expect(uniqueWorksheetName('***', used)).toBe('Sheet');
  });

  test('normalizes presentation colors and rejects unsafe exporter values', () => {
    expect(presentationColor('#a1b2c3', 'FFFFFF')).toBe('A1B2C3');
    expect(presentationColor('rgb(0,0,0)', '17202A')).toBe('17202A');
    expect(presentationColor('black', '17202A')).toBe('17202A');
    expect(presentationColor('#12345678', 'FFFFFF')).toBe('FFFFFF');
  });

  test('builds an ASCII fallback plus RFC 5987 filename for Unicode exports', () => {
    const header = documentContentDisposition('Résumé – 東京.docx');
    expect(header).toContain('filename="Resume.docx"');
    expect(header).toContain("filename*=UTF-8''R%C3%A9sum%C3%A9%20%E2%80%93%20%E6%9D%B1%E4%BA%AC.docx");
    expect(() => new Headers({ 'content-disposition': header })).not.toThrow();
  });
});
