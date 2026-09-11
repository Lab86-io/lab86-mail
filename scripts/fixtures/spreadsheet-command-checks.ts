import * as engine from '@odoo/o-spreadsheet/dist/o_spreadsheet.esm.js';
import { applySheetChangeSet, workbookDataFromGrid } from '../../lib/documents/odoo-spreadsheet-engine';

/** Real engine, isolated model, no provider/auth/transport requests. */
(globalThis as any).verifySpreadsheetCommands = async () => {
  const reports: Array<Record<string, unknown>> = [];
  for (const scenario of [
    'no-op',
    'no-op-only',
    'partial',
    'new-sheet',
    'readonly',
    'success',
    'success-id',
    'unknown-sheet',
  ]) {
    const model = new engine.Model(undefined);
    const sheetId = model.getters.getActiveSheetId();
    const sheetName = model.getters.getSheetName(sheetId);
    model.dispatch('UPDATE_CELL', { sheetId, col: 0, row: 0, content: 'Human edit' });
    const before = model.exportData();
    if (scenario === 'readonly') model.updateMode('readonly');
    const changes =
      scenario === 'no-op' || scenario === 'no-op-only'
        ? [{ sheet: sheetName, cell: 'A1', content: 'Human edit' }]
        : [{ sheet: scenario === 'success-id' ? sheetId : sheetName, cell: 'A1', content: 'AI proposal' }];
    if (scenario === 'unknown-sheet') {
      changes.push({ sheet: 'guessed-sheet-id', cell: 'A1', content: 'Must not create a sheet' });
    } else if (
      scenario !== 'success' &&
      scenario !== 'success-id' &&
      scenario !== 'readonly' &&
      scenario !== 'no-op-only'
    ) {
      changes.push({ sheet: sheetName, cell: 'ZZZ99999', content: 'Outside the worksheet' });
    }
    const outcome = applySheetChangeSet({ model, engine } as any, {
      kind: 'sheet-changes',
      version: 1,
      changes,
      ...(scenario === 'new-sheet' ? { newSheets: ['Temporary proposal'] } : {}),
    });
    const after = model.exportData();
    if (scenario === 'success' || scenario === 'success-id') model.dispatch('REQUEST_UNDO');
    reports.push({
      scenario,
      outcome,
      before: before.sheets,
      after: after.sheets,
      afterUndo: scenario === 'success' || scenario === 'success-id' ? model.exportData().sheets : null,
    });
    await model.leaveSession();
  }
  return reports;
};

/** Typed legacy values must survive both engine reopen and real XLSX export/import. */
(globalThis as any).verifySpreadsheetMigration = async () => {
  const source = workbookDataFromGrid(engine, {
    kind: 'sheet',
    version: 1,
    activeSheetId: 'typed-sheet',
    sheets: [
      {
        id: 'typed-sheet',
        name: 'Typed',
        rowCount: 100,
        columnCount: 26,
        cells: {
          A1: { value: '=SUM(B1)', format: 'text' },
          A2: { value: '="unsafe"' },
          A3: { value: '001' },
          A4: { value: 'TRUE' },
          A5: { value: 1234.5, format: 'currency' },
          A6: { value: 0.125, format: 'percent' },
          A7: { value: 46275, format: 'date' },
          A8: { value: 1234.5, format: 'number' },
          A9: { format: 'currency' },
          A10: { value: '001', format: 'number' },
          A11: { formula: 'A5*2', format: 'currency' },
          A12: { value: false },
          A13: { value: 0 },
          A14: { value: '2026-09-10' },
          A15: { value: '+123' },
          A16: { value: '=path\\folder\nnext\\' },
        },
      },
    ],
  });
  const models: engine.Model[] = [];
  const inspect = (model: engine.Model) => {
    const sheetId = model.getters.getActiveSheetId();
    return Array.from({ length: 16 }, (_, row) => {
      const cell = model.getters.getEvaluatedCell({ sheetId, col: 0, row });
      return {
        address: `A${row + 1}`,
        value: cell.value,
        type: cell.type,
        format: cell.format,
        display: cell.formattedValue,
      };
    });
  };
  try {
    const model = new engine.Model(source);
    models.push(model);
    const initial = inspect(model);
    const reopened = new engine.Model(model.exportData());
    models.push(reopened);
    const files = Object.fromEntries(
      model
        .exportXLSX()
        .files.filter((file) => 'content' in file)
        .map((file) => [file.path, 'content' in file ? file.content : '']),
    );
    const imported = new engine.Model(engine.load(files, true));
    models.push(imported);
    return { initial, reopened: inspect(reopened), imported: inspect(imported) };
  } finally {
    await Promise.all(models.map((model) => model.leaveSession()));
  }
};
