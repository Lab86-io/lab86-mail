import { describe, expect, test } from 'bun:test';
import {
  createDefaultDocumentModel,
  type DocBlock,
  documentFileExtension,
  documentKindLabel,
  documentModelText,
  MAX_SHEET_COLUMNS,
  MAX_SHEET_ROWS,
  parseDocumentModel,
  parseSuggestionPayload,
  type SheetWorkbookModel,
  sheetGridModel,
} from '../lib/documents/model';

function workbook(): SheetWorkbookModel {
  return {
    kind: 'sheet',
    version: 2,
    engine: 'o-spreadsheet',
    engineVersion: '19.0.50',
    activeSheetId: 'forecast',
    workbook: {
      version: '19',
      styles: { '1': { bold: true } },
      sheets: [
        {
          id: 'forecast',
          name: 'Forecast',
          rowNumber: MAX_SHEET_ROWS + 1,
          colNumber: MAX_SHEET_COLUMNS + 1,
          cells: { B2: '=A2*2', A2: '12', A1: 'Revenue', A10001: 'outside native grid' },
          styles: { A1: 1 },
        },
      ],
    },
  };
}

describe('canonical rich document validation', () => {
  test('retains all supported marks and exact Unicode/newline text without duplicating plain projections', () => {
    const blocks: DocBlock[] = [
      { id: 'empty', type: 'paragraph', text: '' },
      {
        id: 'formatted',
        type: 'paragraph',
        text: 'é🐦\nstrong plain',
        runs: [
          { text: 'é🐦\n', bold: true, italic: true, underline: true, strike: true, code: true },
          { text: 'strong', bold: true },
          { text: ' plain', bold: false, italic: false, underline: false, strike: false, code: false },
        ],
      },
    ];
    const model = { kind: 'doc' as const, version: 1 as const, blocks };
    expect(parseDocumentModel(model, 'doc')).toEqual(model);
    expect(documentModelText(model)).toBe('\né🐦\nstrong plain');
  });

  test('rejects stale runs with either a different length or different text of the same length', () => {
    for (const runs of [[{ text: 'stale text' }], [{ text: 'bad' }]]) {
      expect(() =>
        parseDocumentModel({
          kind: 'doc',
          version: 1,
          blocks: [{ id: 'p', type: 'paragraph', text: 'new', runs }],
        }),
      ).toThrow('Block runs must concatenate to exactly the block text.');
    }
  });

  test('empty runs and empty run text are invalid while unformatted empty paragraphs remain valid', () => {
    const block = { id: 'p', type: 'paragraph', text: '' };
    for (const runs of [[], [{ text: '' }]]) {
      expect(() => parseDocumentModel({ kind: 'doc', version: 1, blocks: [{ ...block, runs }] })).toThrow();
    }
    expect(parseDocumentModel({ kind: 'doc', version: 1, blocks: [block] })).toEqual({
      kind: 'doc',
      version: 1,
      blocks: [block],
    });
  });
});

describe('suggestion payload kind boundaries', () => {
  test('accepts valid sheet change sets only for spreadsheet documents', () => {
    const changes = {
      kind: 'sheet-changes',
      version: 1,
      changes: [{ sheet: 'forecast', cell: 'B2', content: '=SUM(A2:A3)' }],
      newSheets: ['Summary'],
    };
    expect(parseSuggestionPayload(changes, 'sheet')).toEqual(changes);
    for (const kind of ['doc', 'deck'] as const) {
      expect(() => parseSuggestionPayload(changes, kind)).toThrow(
        `Expected a ${kind} model, received sheet changes.`,
      );
    }
  });

  test('accepts full models only for the matching document kind and never accepts malformed changes', () => {
    for (const kind of ['doc', 'sheet', 'deck'] as const) {
      const model = createDefaultDocumentModel(kind, 'proposal');
      expect(parseSuggestionPayload(model, kind)).toEqual(model);
      const otherKind = kind === 'doc' ? 'deck' : 'doc';
      expect(() => parseSuggestionPayload(model, otherKind)).toThrow(
        `Expected a ${otherKind} model, received ${kind}.`,
      );
    }
    expect(parseSuggestionPayload(workbook(), 'sheet')).toEqual(workbook());
    expect(() =>
      parseSuggestionPayload({ kind: 'sheet-changes', version: 1, changes: [] }, 'sheet'),
    ).toThrow();
  });
});

describe('document projections and metadata', () => {
  test('grid projection declines docs and decks and preserves the exact legacy sheet model', () => {
    expect(sheetGridModel(createDefaultDocumentModel('doc'))).toBeNull();
    expect(sheetGridModel(createDefaultDocumentModel('deck'))).toBeNull();
    const legacy = createDefaultDocumentModel('sheet', 'legacy');
    expect(sheetGridModel(legacy)).toBe(legacy);
  });

  test('engine sheets project into bounded native grids without mutating their full canonical snapshot', () => {
    const model = workbook();
    const original = structuredClone(model);
    expect(sheetGridModel(model)).toEqual({
      kind: 'sheet',
      version: 1,
      activeSheetId: 'forecast',
      sheets: [
        {
          id: 'forecast',
          name: 'Forecast',
          rowCount: MAX_SHEET_ROWS,
          columnCount: MAX_SHEET_COLUMNS,
          cells: { A1: { value: 'Revenue' }, A2: { value: 12 }, B2: { formula: 'A2*2' } },
        },
      ],
    });
    expect(documentModelText(model)).toBe(
      'Forecast\nA1: Revenue\nA2: 12\nB2: =A2*2\nA10001: outside native grid',
    );
    expect(model).toEqual(original);
  });

  test('plain-text projections preserve zero, false, empty cells, and optional slide content', () => {
    expect(
      documentModelText({
        kind: 'sheet',
        version: 1,
        activeSheetId: 'values',
        sheets: [
          {
            id: 'values',
            name: 'Values',
            rowCount: 10,
            columnCount: 5,
            cells: {
              A10: {},
              A2: { value: false },
              A1: { value: 0 },
              B1: { formula: '1+1', value: 2 },
            },
          },
        ],
      }),
    ).toBe('Values\nA1: 0\nA2: false\nA10: \nB1: 1+1');
    expect(
      documentModelText({
        kind: 'deck',
        version: 1,
        activeSlideId: 'slide',
        slides: [
          {
            id: 'slide',
            title: 'Decision',
            elements: [
              { id: 'shape', type: 'shape', x: 0, y: 0, width: 10, height: 10 },
              { id: 'blank', type: 'text', x: 0, y: 10, width: 10, height: 10, text: '' },
              { id: 'body', type: 'text', x: 0, y: 20, width: 20, height: 10, text: 'Ship safely' },
            ],
          },
        ],
      }),
    ).toBe('Slide 1: Decision\nShip safely');
  });

  test('labels and export extensions match each canonical document kind', () => {
    expect(
      (['doc', 'sheet', 'deck'] as const).map((kind) => [
        documentKindLabel(kind),
        documentFileExtension(kind),
      ]),
    ).toEqual([
      ['Document', 'docx'],
      ['Spreadsheet', 'xlsx'],
      ['Presentation', 'pptx'],
    ]);
  });
});
