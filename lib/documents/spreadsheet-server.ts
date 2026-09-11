/** Run the pinned engine in a private DOM realm; never install browser globals on the server. */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import { createCanvas, Path2D } from '@napi-rs/canvas';
import { JSDOM, VirtualConsole } from 'jsdom';
import type { AlbatrossDocumentModel } from './model';
import { workbookDataFromGrid } from './odoo-spreadsheet-engine';
import {
  assertModelWithinLimit,
  ODOO_SPREADSHEET_VERSION,
  type SheetChangeSet,
  type SheetWorkbookModel,
  sheetChangeSetSchema,
  sheetWorkbookModelSchema,
} from './sheet-workbook';
import { validateSpreadsheetCommand } from './spreadsheet-commands';

const require = createRequire(import.meta.url);
let scripts: Promise<Script[]> | undefined;
function engineScripts() {
  scripts ??= Promise.all([
    readFile(require.resolve('@odoo/owl/dist/owl.iife.js'), 'utf8'),
    readFile(require.resolve('@odoo/o-spreadsheet/dist/o_spreadsheet.iife.js'), 'utf8'),
  ]).then((sources) => sources.map((source) => new Script(source)));
  return scripts;
}

const execute = new Script(`
  const input = JSON.parse(inputJSON);
  const model = new o_spreadsheet.Model(input.workbook, { mode: 'normal' });
  try {
    if (input.activeSheetId && model.getters.getSheetIds().includes(input.activeSheetId)) {
      model.dispatch('ACTIVATE_SHEET', { sheetIdFrom: model.getters.getActiveSheetId(), sheetIdTo: input.activeSheetId });
    }
    const dispatch = (type, payload) => {
      const result = model.dispatch(type, payload);
      if (!result.isSuccessful && !result.reasons.every(reason => String(reason) === 'NoChanges')) {
        throw new Error(type + ' rejected: ' + result.reasons.join(', '));
      }
    };
    for (const name of input.plan.newSheets || []) {
      if (!model.getters.getSheetIdByName(name)) dispatch('CREATE_SHEET', { sheetId: new o_spreadsheet.helpers.UuidGenerator().uuidv4(), name, position: model.getters.getSheetIds().length });
    }
    for (const change of input.plan.changes) {
      const sheetId = model.getters.getSheetIds().includes(change.sheet) ? change.sheet : model.getters.getSheetIdByName(change.sheet);
      if (!sheetId) throw new Error('Unknown sheet: ' + change.sheet);
      const { col, row } = o_spreadsheet.helpers.toCartesian(change.cell);
      if (col >= model.getters.getNumberCols(sheetId) || row >= model.getters.getNumberRows(sheetId)) throw new Error('Cell outside sheet: ' + change.cell);
      dispatch('UPDATE_CELL', { sheetId, col, row, content: change.content });
    }
    for (const command of input.plan.commands || []) {
      if (command.selection) {
        const {sheetId, zone} = command.selection;
        if (!model.getters.getSheetIds().includes(sheetId) || zone.bottom < zone.top || zone.right < zone.left || zone.bottom >= model.getters.getNumberRows(sheetId) || zone.right >= model.getters.getNumberCols(sheetId)) throw new Error('Invalid selection');
        dispatch('ACTIVATE_SHEET', {sheetIdFrom:model.getters.getActiveSheetId(), sheetIdTo:sheetId});
        model.selection.selectZone({zone, cell:{col:zone.left,row:zone.top}});
      }
      dispatch(command.type, command.payload);
    }
    outputJSON = JSON.stringify({kind:'sheet', version:2, engine:'o-spreadsheet', engineVersion:o_spreadsheet.__info__.version, workbook:model.exportData(), activeSheetId:model.getters.getActiveSheetId()});
  } finally { model.leaveSession(); }
`);

export async function applySpreadsheetChanges(
  source: AlbatrossDocumentModel,
  input: SheetChangeSet,
): Promise<SheetWorkbookModel> {
  if (source.kind !== 'sheet') throw new Error('Spreadsheet commands require a spreadsheet.');
  const plan = sheetChangeSetSchema.parse(input);
  plan.commands?.forEach(validateSpreadsheetCommand);
  assertModelWithinLimit(plan);
  const loaded = await engineScripts();
  const dom = new JSDOM('', {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
  });
  try {
    const window = dom.window;
    Object.assign(window, { Path2D, fetch: undefined, XMLHttpRequest: undefined, WebSocket: undefined });
    window.HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
      return createCanvas(this.width || 300, this.height || 150).getContext('2d');
    } as any;
    const context = dom.getInternalVMContext();
    for (const script of loaded) script.runInContext(context, { timeout: 10_000 });
    const engine = (window as any).o_spreadsheet;
    if (engine.__info__.version !== ODOO_SPREADSHEET_VERSION)
      throw new Error('Spreadsheet engine version mismatch.');
    (window as any).inputJSON = JSON.stringify({
      workbook: source.version === 2 ? source.workbook : workbookDataFromGrid(engine, source),
      activeSheetId: source.activeSheetId,
      plan,
    });
    execute.runInContext(context, { timeout: 10_000 });
    const result = sheetWorkbookModelSchema.parse(JSON.parse((window as any).outputJSON));
    assertModelWithinLimit(result);
    return result;
  } finally {
    dom.window.close();
  }
}
