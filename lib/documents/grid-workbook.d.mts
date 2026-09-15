import type { OdooWorkbookData } from '@odoo/o-spreadsheet/dist/o_spreadsheet.esm.js';
import type { SheetGridModel } from './model';
export function workbookDataFromGrid(
  engine: typeof import('@odoo/o-spreadsheet/dist/o_spreadsheet.esm.js'),
  grid: SheetGridModel,
): OdooWorkbookData;
