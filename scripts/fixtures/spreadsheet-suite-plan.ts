import type { SpreadsheetCommand } from '../../lib/documents/spreadsheet-commands';

const zone = { top: 0, bottom: 4, left: 0, right: 1 };
export const sheetId = 'suite-sheet-1';
const ranges = [{ _sheetId: sheetId, _zone: zone }];
export const chart: SpreadsheetCommand = {
  type: 'CREATE_CHART',
  payload: {
    sheetId,
    chartId: 'monthly-chart',
    figureId: 'monthly-figure',
    col: 3,
    row: 1,
    offset: { x: 0, y: 0 },
    size: { width: 480, height: 300 },
    definition: {
      type: 'bar',
      title: { text: 'Monthly commits' },
      dataSets: [{ dataRange: 'B1:B5' }],
      labelRange: 'A2:A5',
      dataSetsHaveTitle: true,
      legendPosition: 'none',
      stacked: false,
    },
  },
};
export const suiteCommands: SpreadsheetCommand[] = [
  {
    type: 'SET_FORMATTING',
    payload: {
      sheetId,
      target: [{ ...zone, bottom: 0 }],
      style: { bold: true, fillColor: '#ddeeff', textColor: '#112233' },
    },
  },
  {
    type: 'CREATE_TABLE',
    payload: {
      sheetId,
      ranges,
      tableType: 'static',
      config: {
        hasFilters: true,
        totalRow: false,
        firstColumn: false,
        lastColumn: false,
        numberOfHeaders: 1,
        bandedRows: true,
        bandedColumns: false,
        styleId: 'TableStyleMedium2',
      },
    },
  },
  chart,
  {
    type: 'ADD_CONDITIONAL_FORMAT',
    payload: {
      sheetId,
      ranges,
      cf: {
        id: 'high',
        rule: { type: 'CellIsRule', operator: 'isGreaterThan', values: ['5'], style: { bold: true } },
      },
    },
  },
  {
    type: 'ADD_DATA_VALIDATION_RULE',
    payload: {
      sheetId,
      ranges: [{ _sheetId: sheetId, _zone: { top: 1, bottom: 4, left: 1, right: 1 } }],
      rule: { id: 'nonnegative', criterion: { type: 'isGreaterOrEqualTo', values: ['0'] } },
    },
  },
  {
    type: 'ADD_PIVOT',
    payload: {
      pivotId: '1',
      pivot: {
        type: 'SPREADSHEET',
        name: 'Monthly summary',
        dataSet: { sheetId, zone },
        rows: [{ fieldName: 'Month' }],
        columns: [],
        measures: [{ id: 'Commits:sum', fieldName: 'Commits', aggregator: 'sum' }],
      },
    },
  },
  { type: 'FREEZE_ROWS', payload: { sheetId, quantity: 1 } },
  { type: 'RESIZE_COLUMNS_ROWS', payload: { sheetId, dimension: 'COL', elements: [0], size: 160 } },
];
export const changes = [
  ['A1', 'Month'],
  ['B1', 'Commits'],
  ['A2', 'Jun 2026'],
  ['B2', '1'],
  ['A3', 'Jul 2026'],
  ['B3', '13'],
  ['A4', 'Aug 2026'],
  ['B4', '7'],
  ['A5', 'Sep 2026'],
  ['B5', '4'],
].map(([cell, content]) => ({ sheet: sheetId, cell, content }));
