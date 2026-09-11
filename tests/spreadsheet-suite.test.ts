import { describe, expect, test } from 'bun:test';
import { prepareDocumentEdits } from '../lib/documents/edits';
import { createDefaultDocumentModel } from '../lib/documents/model';
import { sheetChangeSetSchema } from '../lib/documents/sheet-workbook';
import {
  type SpreadsheetCommand,
  spreadsheetCapabilities,
  validateSpreadsheetCommand,
} from '../lib/documents/spreadsheet-commands';
import { MAX_SPREADSHEET_IMAGE_BYTES, spreadsheetImageStore } from '../lib/documents/spreadsheet-image-store';
import { applySpreadsheetChanges } from '../lib/documents/spreadsheet-server';

import { changes, chart, sheetId, suiteCommands } from '../scripts/fixtures/spreadsheet-suite-plan';

describe('full Odoo spreadsheet tools', () => {
  test('inserted images persist as workbook-owned bytes and unsafe or oversized files are refused', async () => {
    const image = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' });
    const path = await spreadsheetImageStore.upload(image);
    expect(new Uint8Array(await (await spreadsheetImageStore.getFile(path)).arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );
    await spreadsheetImageStore.delete(path);
    expect((await spreadsheetImageStore.getFile(path)).size).toBe(4);
    await expect(
      spreadsheetImageStore.upload(new Blob(['<svg/>'], { type: 'image/svg+xml' })),
    ).rejects.toThrow('supported image');
    await expect(
      spreadsheetImageStore.upload(
        new Blob([new Uint8Array(MAX_SPREADSHEET_IMAGE_BYTES + 1)], { type: 'image/png' }),
      ),
    ).rejects.toThrow('400 KB');
  });
  test('catalog includes every workbook feature family and exact nested contracts', () => {
    const catalog = spreadsheetCapabilities(['CREATE_CHART', 'CREATE_TABLE', 'ADD_PIVOT']);
    expect(catalog.commands.length).toBe(111);
    for (const name of [
      'CREATE_IMAGE',
      'CREATE_CAROUSEL',
      'SET_BORDER',
      'CREATE_TABLE_STYLE',
      'GROUP_HEADERS',
      'SORT_CELLS',
      'AUTOFILL',
      'ADD_DATA_VALIDATION_RULE',
      'ADD_CONDITIONAL_FORMAT',
      'UPDATE_CHART',
    ])
      expect(catalog.commands).toContain(name);
    expect(catalog.functions).toContain('SUM');
    expect(catalog.functions).not.toContain('REPT');
    expect(Object.keys(catalog.schemas)).toEqual(['CREATE_CHART', 'CREATE_TABLE', 'ADD_PIVOT']);
    for (const command of suiteCommands) expect(validateSpreadsheetCommand(command)).toEqual(command);
    expect(() =>
      validateSpreadsheetCommand({
        type: 'CREATE_CHART',
        payload: { sheetId, definition: { type: 'imaginary' } },
      }),
    ).toThrow();
    expect(() => validateSpreadsheetCommand({ type: 'REQUEST_UNDO', payload: {} })).toThrow();
    expect(() =>
      validateSpreadsheetCommand({ type: 'UPDATE_CELL', payload: { type: 'DELETE_SHEET', sheetId } }),
    ).toThrow();
  });

  test('real engine persists charts, styled tables, pivots, validation, conditional styles, and dimensions across reopen', async () => {
    const source = createDefaultDocumentModel('sheet', 'suite');
    const before = structuredClone(source);
    const workbook = await applySpreadsheetChanges(source, {
      kind: 'sheet-changes',
      version: 1,
      changes,
      commands: suiteCommands,
    });
    expect(source).toEqual(before);
    const sheet = workbook.workbook.sheets[0];
    expect(sheet.cells?.B3).toBe('13');
    expect(sheet.figures).toMatchObject([
      { id: 'monthly-figure', tag: 'chart', data: { type: 'bar', title: { text: 'Monthly commits' } } },
    ]);
    expect(sheet.tables).toHaveLength(1);
    expect(sheet.conditionalFormats).toHaveLength(1);
    expect(sheet.dataValidationRules).toHaveLength(1);
    expect(workbook.workbook.pivots).toMatchObject({ '1': { name: 'Monthly summary' } });
    const reopened = await applySpreadsheetChanges(workbook, {
      kind: 'sheet-changes',
      version: 1,
      changes: [{ sheet: sheetId, cell: 'B5', content: '5' }],
    });
    for (const feature of [
      'figures',
      'tables',
      'conditionalFormats',
      'dataValidationRules',
      'styles',
      'cols',
      'panes',
    ])
      expect(reopened.workbook.sheets[0][feature]).toEqual(sheet[feature]);
    expect(reopened.workbook.pivots).toEqual(workbook.workbook.pivots);
  });

  test('invalid commands after valid edits discard the entire candidate and preserve the input', async () => {
    const source = createDefaultDocumentModel('sheet', 'suite');
    const before = structuredClone(source);
    await expect(
      applySpreadsheetChanges(source, {
        kind: 'sheet-changes',
        version: 1,
        changes,
        commands: [chart, { type: 'DELETE_SHEET', payload: { sheetId: 'missing', sheetName: 'Missing' } }],
      }),
    ).rejects.toThrow();
    expect(source).toEqual(before);
    expect(
      sheetChangeSetSchema.safeParse({ kind: 'sheet-changes', version: 1, changes: [], commands: [] })
        .success,
    ).toBe(false);
  });

  test('commands preserve ordering and allow new sheets, resizing, and selection-based cleanup', async () => {
    const source = createDefaultDocumentModel('sheet', 'suite');
    const commands: SpreadsheetCommand[] = [
      {
        type: 'CREATE_SHEET',
        payload: { sheetId: 'new-sheet', name: 'New', position: 1, cols: 26, rows: 100 },
      },
      { type: 'UPDATE_CELL', payload: { sheetId: 'new-sheet', col: 0, row: 0, content: '  trim me  ' } },
      {
        type: 'TRIM_WHITESPACE',
        payload: {},
        selection: { sheetId: 'new-sheet', zone: { top: 0, bottom: 0, left: 0, right: 0 } },
      },
    ];
    const plan = prepareDocumentEdits(
      source,
      commands.map((command) => ({ op: 'spreadsheet_command', command })),
    );
    if (plan.kind !== 'sheet-changes') throw new Error('Expected commands');
    const result = await applySpreadsheetChanges(source, plan);
    expect(result.workbook.sheets[1].cells?.A1).toBe('trim me');
    expect(result.activeSheetId).toBe('new-sheet');
  });
});
