/** Private worker: synchronous engine work cannot block the request event loop. */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import { workbookDataFromGrid } from './grid-workbook.mjs';

const require = createRequire(import.meta.url);
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

export async function executeSpreadsheetWorker(workerData) {
  const { JSDOM, VirtualConsole } = require(workerData.jsdomPath);
  const { createCanvas, Path2D } = require(workerData.canvasPath);
  let dom;
  try {
    const { source, plan, version, enginePaths } = workerData;
    const scripts = await Promise.all(enginePaths.map((path) => readFile(path, 'utf8')));
    dom = new JSDOM('', {
      runScripts: 'outside-only',
      pretendToBeVisual: true,
      virtualConsole: new VirtualConsole(),
    });
    const window = dom.window;
    Object.assign(window, { Path2D, fetch: undefined, XMLHttpRequest: undefined, WebSocket: undefined });
    window.HTMLCanvasElement.prototype.getContext = function () {
      return createCanvas(this.width || 300, this.height || 150).getContext('2d');
    };
    const context = dom.getInternalVMContext();
    for (const code of scripts) new Script(code).runInContext(context, { timeout: 10000 });
    const engine = window.o_spreadsheet;
    if (engine.__info__.version !== version) throw new Error('Spreadsheet engine version mismatch.');
    window.inputJSON = JSON.stringify({
      workbook: source.version === 2 ? source.workbook : workbookDataFromGrid(engine, source),
      activeSheetId: source.activeSheetId,
      plan,
    });
    execute.runInContext(context, { timeout: 10000 });
    return JSON.parse(window.outputJSON);
  } finally {
    dom?.window.close();
  }
}

if (process.send && process.connected) {
  process.once('message', async (workerData) => {
    try {
      process.send({ output: await executeSpreadsheetWorker(workerData) });
    } catch (error) {
      process.send({
        error: typeof error?.message === 'string' ? error.message : 'Spreadsheet execution failed.',
      });
    } finally {
      process.disconnect();
    }
  });
}
