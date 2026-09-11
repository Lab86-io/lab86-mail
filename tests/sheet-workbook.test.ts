import { describe, expect, test } from 'bun:test';
import {
  assertModelWithinLimit,
  columnLetters,
  DocumentTooLargeError,
  isSheetChangeSet,
  isSheetWorkbookModel,
  MAX_DOCUMENT_MODEL_BYTES,
  MAX_SHEET_CHANGES,
  MAX_WORKBOOK_SHEETS,
  modelByteLength,
  parseCellAddress,
  projectWorkbookToSheetV1,
  type SheetWorkbookModel,
  sheetChangeSetSchema,
  sheetWorkbookModelSchema,
  workbookCellEntries,
  workbookDataSchema,
  workbookText,
} from '../lib/documents/sheet-workbook';

function workbook(): SheetWorkbookModel {
  return {
    kind: 'sheet',
    version: 2,
    engine: 'o-spreadsheet',
    engineVersion: '19.0.50',
    activeSheetId: 'actuals',
    workbook: {
      version: '19',
      sheets: [
        {
          id: 'forecast',
          name: 'Forecast',
          rowNumber: 100,
          colNumber: 26,
          cells: { B2: '=SUM(A1:A2)', A2: '25', B1: 'Revenue', A1: '12' },
        },
        { id: 'actuals', name: 'Actuals', rowNumber: 10, colNumber: 8, cells: { A1: '37' } },
      ],
    },
  };
}

describe('workbook model boundaries', () => {
  test('recognizes tagged payloads without confusing sheets, change sets, or primitive data', () => {
    expect(isSheetWorkbookModel(workbook())).toBe(true);
    expect(isSheetChangeSet({ kind: 'sheet-changes', version: 1, changes: [] })).toBe(true);
    for (const value of [undefined, null, 2, 'sheet', [], {}, { kind: 'doc', version: 2 }]) {
      expect(isSheetWorkbookModel(value)).toBe(false);
      expect(isSheetChangeSet(value)).toBe(false);
    }
    expect(isSheetWorkbookModel({ kind: 'sheet', version: 1 })).toBe(false);
    expect(isSheetChangeSet(workbook())).toBe(false);
    expect(isSheetWorkbookModel({ kind: 'sheet-changes', version: 1 })).toBe(false);
  });

  test('accepts engine extensions and supported sheet and grid limits without stripping data', () => {
    const model = workbook();
    model.workbook.revisionId = 'revision';
    model.workbook.customPlugin = { preserved: true };
    model.workbook.sheets[0] = {
      ...model.workbook.sheets[0],
      isVisible: false,
      rowNumber: 1_000_000,
      colNumber: 20_000,
      merges: ['A1:B1'],
    };
    expect(sheetWorkbookModelSchema.parse(model)).toEqual(model);
    expect(
      workbookDataSchema.safeParse({
        version: 19,
        sheets: Array.from({ length: MAX_WORKBOOK_SHEETS }, (_, index) => ({
          id: `sheet-${index}`,
          name: `Sheet ${index}`,
          rowNumber: 1,
          colNumber: 1,
        })),
      }).success,
    ).toBe(true);
  });

  test('rejects malformed snapshots and out-of-bounds sheet data before persistence', () => {
    const model = workbook();
    const invalidSheets = [
      { id: '' },
      { name: 'x'.repeat(201) },
      { rowNumber: 0 },
      { rowNumber: 1_000_001 },
      { rowNumber: 1.5 },
      { colNumber: 0 },
      { colNumber: 20_001 },
      { cells: { A1: 42 } },
      { cells: { A1: 'x'.repeat(100_001) } },
      { isVisible: 'yes' },
    ];
    for (const invalid of invalidSheets) {
      expect(
        workbookDataSchema.safeParse({
          ...model.workbook,
          sheets: [{ ...model.workbook.sheets[0], ...invalid }],
        }).success,
      ).toBe(false);
    }
    for (const invalid of [
      { engine: 'other-engine' },
      { version: 1 },
      { engineVersion: '' },
      { workbook: { ...model.workbook, sheets: [] } },
      { workbook: { ...model.workbook, sheets: Array(201).fill(model.workbook.sheets[0]) } },
      { workbook: { ...model.workbook, version: 'x'.repeat(41) } },
    ]) {
      expect(sheetWorkbookModelSchema.safeParse({ ...model, ...invalid }).success).toBe(false);
    }
  });

  test('validates bounded AI cell changes, including clears and explicitly named new sheets', () => {
    const change = { sheet: 'Forecast', cell: 'A1', content: '' };
    const payload = { kind: 'sheet-changes', version: 1, changes: [change], newSheets: ['Plan'] };
    expect(sheetChangeSetSchema.parse(payload)).toEqual(payload);
    expect(
      sheetChangeSetSchema.safeParse({
        ...payload,
        changes: Array(MAX_SHEET_CHANGES).fill({ ...change, cell: 'ZZZ9999999', content: '=1+1' }),
        newSheets: Array(20).fill('Plan'),
      }).success,
    ).toBe(true);
    for (const changes of [[], Array(MAX_SHEET_CHANGES + 1).fill(change)]) {
      expect(sheetChangeSetSchema.safeParse({ ...payload, changes }).success).toBe(false);
    }
    for (const cell of ['a1', 'A0', 'A-1', 'A1:B2', '$A$1', 'AAAA1', 'A10000000']) {
      expect(sheetChangeSetSchema.safeParse({ ...payload, changes: [{ ...change, cell }] }).success).toBe(
        false,
      );
    }
    for (const newSheets of [[''], Array(21).fill('Plan')]) {
      expect(sheetChangeSetSchema.safeParse({ ...payload, newSheets }).success).toBe(false);
    }
  });
});

describe('stable workbook projections', () => {
  test('converts column indices and parses mixed-case A1 addresses', () => {
    for (const [index, label] of [
      [1, 'A'],
      [26, 'Z'],
      [27, 'AA'],
      [52, 'AZ'],
      [703, 'AAA'],
      [16_384, 'XFD'],
    ] as const) {
      expect(columnLetters(index)).toBe(label);
      expect(parseCellAddress(`${label.toLowerCase()}42`)).toEqual({ column: index, row: 42 });
    }
    expect(columnLetters(0)).toBe('');
    expect(columnLetters(-1)).toBe('');
    for (const address of ['', 'A', '1', '$A$1', 'A1:B2', ' A1', 'A-1']) {
      expect(parseCellAddress(address)).toBeNull();
    }
  });

  test('preserves sheet order, sorts rows then columns, and filters empty or invalid entries', () => {
    const model = workbook();
    model.workbook.sheets[0].cells = {
      Z1: 'last column',
      A10: 'later row',
      B2: '=SUM(A1:A2)',
      A2: '25',
      A1: '12',
      B1: '',
      C1: undefined,
      invalid: 'not a cell',
    };
    delete model.workbook.sheets[1].cells;
    expect(workbookCellEntries(model.workbook)).toEqual([
      {
        id: 'forecast',
        name: 'Forecast',
        cells: [
          { address: 'A1', content: '12', position: { column: 1, row: 1 } },
          { address: 'Z1', content: 'last column', position: { column: 26, row: 1 } },
          { address: 'A2', content: '25', position: { column: 1, row: 2 } },
          { address: 'B2', content: '=SUM(A1:A2)', position: { column: 2, row: 2 } },
          { address: 'A10', content: 'later row', position: { column: 1, row: 10 } },
        ],
      },
      { id: 'actuals', name: 'Actuals', cells: [] },
    ]);
  });

  test('provides sorted grounded text and caps cell count across the entire workbook', () => {
    const model = workbook();
    expect(workbookText(model)).toBe(
      'Forecast\nA1: 12\nB1: Revenue\nA2: 25\nB2: =SUM(A1:A2)\nActuals\nA1: 37',
    );
    expect(workbookText(model, { maxCells: 0 })).toBe('Forecast\n…');
    expect(workbookText(model, { maxCells: 2 })).toBe('Forecast\nA1: 12\nB1: Revenue\n…');
    expect(workbookText(model, { maxCells: 4 })).toEndWith('Actuals\n…');
    expect(workbookText(model, { maxCells: 5 })).toBe(workbookText(model));
    delete model.workbook.sheets[0].cells;
    expect(workbookText(model)).toBe('Forecast\nActuals\nA1: 37');
  });

  test('projects values and formulas with per-sheet limits without modifying the canonical workbook', () => {
    const model = workbook();
    model.workbook.sheets[0].cells = {
      A1: '12.5',
      B1: ' Revenue ',
      C1: 'discard: outside columns',
      A2: '=SUM(A1:A1)',
      B2: '  ',
      A3: 'Infinity',
      B3: '-25',
      A4: 'discard: outside rows',
    };
    const original = structuredClone(model);
    expect(projectWorkbookToSheetV1(model, { maxRows: 3, maxColumns: 2, maxCells: 6 })).toEqual({
      kind: 'sheet',
      version: 1,
      activeSheetId: 'actuals',
      sheets: [
        {
          id: 'forecast',
          name: 'Forecast',
          rowCount: 3,
          columnCount: 2,
          cells: {
            A1: { value: 12.5 },
            B1: { value: ' Revenue ' },
            A2: { formula: 'SUM(A1:A1)' },
            B2: { value: '  ' },
            A3: { value: 'Infinity' },
            B3: { value: -25 },
          },
        },
        { id: 'actuals', name: 'Actuals', rowCount: 3, columnCount: 2, cells: { A1: { value: 37 } } },
      ],
    });
    const capped = projectWorkbookToSheetV1(model, { maxRows: 100, maxColumns: 26, maxCells: 1 });
    expect(capped.sheets.map((sheet) => sheet.cells)).toEqual([
      { A1: { value: 12.5 } },
      { A1: { value: 37 } },
    ]);
    expect(model).toEqual(original);
  });

  test('skips out-of-range rows and recovers an absent active sheet to the first sheet', () => {
    const model = workbook();
    model.activeSheetId = 'deleted-sheet';
    model.workbook.sheets[0].cells = { A1: '1', A99: '99', Z1: 'outside' };
    const result = projectWorkbookToSheetV1(model, { maxRows: 10, maxColumns: 3, maxCells: 100 });
    expect(result.activeSheetId).toBe('forecast');
    expect(result.sheets[0].cells).toEqual({ A1: { value: 1 } });
    expect(result.sheets[1]).toMatchObject({ rowCount: 10, columnCount: 3 });
    delete model.activeSheetId;
    expect(
      projectWorkbookToSheetV1(model, { maxRows: 100, maxColumns: 26, maxCells: 0 }).sheets[0].cells,
    ).toEqual({});
    // The projection is defensive even for an empty in-memory draft; persistence rejects this snapshot.
    model.workbook.sheets = [];
    expect(projectWorkbookToSheetV1(model, { maxRows: 100, maxColumns: 26, maxCells: 100 })).toEqual({
      kind: 'sheet',
      version: 1,
      activeSheetId: 'sheet-1',
      sheets: [{ id: 'sheet-1', name: 'Sheet 1', rowCount: 100, columnCount: 26, cells: {} }],
    });
  });
});

test('enforces the UTF-8 serialized size boundary with an actionable typed error', () => {
  expect(modelByteLength({ text: 'é🐦' })).toBe(Buffer.byteLength(JSON.stringify({ text: 'é🐦' }), 'utf8'));
  expect(assertModelWithinLimit('x'.repeat(MAX_DOCUMENT_MODEL_BYTES - 2))).toBe(MAX_DOCUMENT_MODEL_BYTES);
  try {
    assertModelWithinLimit('x'.repeat(MAX_DOCUMENT_MODEL_BYTES - 1));
    throw new Error('Expected size rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(DocumentTooLargeError);
    expect((error as Error).name).toBe('DocumentTooLargeError');
    expect((error as Error).message).toContain('Remove data or split the workbook');
  }
});
