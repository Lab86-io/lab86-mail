import { expect, mock, test } from 'bun:test';
import type {
  OdooModelConfig,
  OdooWorkbookData,
  OdooXlsxExport,
} from '@odoo/o-spreadsheet/dist/o_spreadsheet.esm.js';
import JSZip from 'jszip';
import type { SheetGridModel } from '../lib/documents/model';
import {
  applySheetChangeSet,
  createSpreadsheetSession,
  downloadBlob,
  exportXlsxBlob,
  importXlsxWorkbook,
  type LoadedEngine,
  workbookDataFromGrid,
  XLSX_MIME,
} from '../lib/documents/odoo-spreadsheet-engine';
import {
  ODOO_SPREADSHEET_ENGINE,
  ODOO_SPREADSHEET_VERSION,
  type SheetChangeSet,
  type SheetWorkbookModel,
} from '../lib/documents/sheet-workbook';
import { MAX_XLSX_BYTES } from '../lib/documents/xlsx-validation';

// This injected engine verifies our adapter protocol and failure handling, not
// Office fidelity. The real pinned engine has separate browser acceptance.
const emptySheet = (id: string, name: string) => ({ id, name, colNumber: 26, rowNumber: 100, cells: {} });
const initialWorkbook = (): OdooWorkbookData => ({
  version: '19',
  revisionId: 'revision-original',
  sheets: [emptySheet('stable-plan', 'Plan'), emptySheet('stable-notes', 'Notes')],
  styles: { 'style-1': { bold: true } },
  custom: { preserved: true },
});
const savedModel = (): SheetWorkbookModel => ({
  kind: 'sheet',
  version: 2,
  engine: ODOO_SPREADSHEET_ENGINE,
  engineVersion: ODOO_SPREADSHEET_VERSION,
  workbook: initialWorkbook(),
  activeSheetId: 'stable-notes',
});
const plan = (changes: SheetChangeSet['changes'], newSheets?: string[]): SheetChangeSet => ({
  kind: 'sheet-changes',
  version: 1,
  changes,
  ...(newSheets ? { newSheets } : {}),
});

function harness(
  options: {
    mountGate?: Promise<void>;
    reject?: (type: string, payload: Record<string, unknown>) => string[] | undefined;
  } = {},
) {
  const calls: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const apps: Array<{
    options: Record<string, unknown>;
    mount: ReturnType<typeof mock>;
    destroy: ReturnType<typeof mock>;
  }> = [];
  const sent: string[] = [];
  let config: OdooModelConfig | undefined;
  let nextId = 0;
  class Transport {
    async sendMessage(message: { type: string }) {
      sent.push(message.type);
    }
  }
  class AdapterModel {
    data: OdooWorkbookData;
    active: string;
    mode: string;
    undo: OdooWorkbookData[] = [];
    files: OdooXlsxExport = { name: 'Plan', files: [] };
    leaveSession = mock(async () => undefined);
    updateMode = mock((mode: string) => {
      this.mode = mode;
    });
    constructor(data: OdooWorkbookData, supplied: OdooModelConfig) {
      this.data = structuredClone(data);
      this.active = data.sheets[0].id;
      this.mode = supplied.mode || 'normal';
      config = supplied;
    }
    getters = {
      getActiveSheetId: () => this.active,
      getSheetIds: () => this.data.sheets.map((sheet) => sheet.id),
      getSheetIdByName: (name: string) => this.data.sheets.find((sheet) => sheet.name === name)?.id,
      getNumberCols: (id: string) => this.data.sheets.find((sheet) => sheet.id === id)!.colNumber,
      getNumberRows: (id: string) => this.data.sheets.find((sheet) => sheet.id === id)!.rowNumber,
      isReadonly: () => this.mode === 'readonly',
    };
    exportData = () => structuredClone(this.data);
    exportXLSX = () => this.files;
    dispatch(type: string, payload: Record<string, unknown> = {}) {
      calls.push({ type, payload });
      const rejected = options.reject?.(type, payload);
      if (rejected) return { isSuccessful: false, reasons: rejected };
      if (type === 'ACTIVATE_SHEET') this.active = String(payload.sheetIdTo);
      if (type === 'CREATE_SHEET') {
        this.undo.push(structuredClone(this.data));
        this.data.sheets.push(emptySheet(String(payload.sheetId), String(payload.name)));
      }
      if (type === 'UPDATE_CELL') {
        this.undo.push(structuredClone(this.data));
        const sheet = this.data.sheets.find((sheet) => sheet.id === payload.sheetId)!;
        sheet.cells[`${Number(payload.col)}:${Number(payload.row)}`] = String(payload.content);
      }
      if (type === 'REQUEST_UNDO') this.data = this.undo.pop()!;
      return { isSuccessful: true, reasons: [] };
    }
  }
  class App {
    options: Record<string, unknown>;
    mount = mock(async (_container: HTMLElement) => {
      await options.mountGate;
    });
    destroy = mock(() => undefined);
    constructor(_component: unknown, supplied: Record<string, unknown>) {
      this.options = supplied;
      apps.push(this);
    }
  }
  const load = mock((_files: Record<string, string>, _verbose: boolean) => initialWorkbook());
  const loaded = {
    engine: {
      __info__: { version: ODOO_SPREADSHEET_VERSION },
      Model: AdapterModel,
      Spreadsheet: 'Spreadsheet component',
      LocalTransportService: Transport,
      helpers: {
        createEmptyWorkbookData: (name: string) => ({
          ...initialWorkbook(),
          sheets: [emptySheet('initial', name)],
        }),
        createEmptySheet: emptySheet,
        toCartesian: (address: string) => {
          const [, letters, row] = /^([A-Z]+)(\d+)$/u.exec(address)!;
          let col = 0;
          for (const letter of letters) col = col * 26 + letter.charCodeAt(0) - 64;
          return { col: col - 1, row: Number(row) - 1 };
        },
        UuidGenerator: class {
          uuidv4() {
            return `generated-${++nextId}`;
          }
        },
      },
      load,
    },
    owl: { App },
    templates: '<templates/>',
  } as unknown as LoadedEngine;
  const changed = mock(() => undefined);
  const create = (model: SheetWorkbookModel | SheetGridModel = savedModel(), readOnly = false) => {
    const notifyUser = mock(() => undefined);
    const raiseError = mock(() => undefined);
    const askConfirmation = mock(() => undefined);
    const session = createSpreadsheetSession({
      loaded,
      model,
      readOnly,
      onContentChange: changed,
      notifyUser,
      raiseError,
      askConfirmation,
    });
    return {
      session,
      model: session.model as unknown as AdapterModel,
      notifyUser,
      raiseError,
      askConfirmation,
    };
  };
  return { loaded, load, create, calls, apps, sent, changed, config: () => config! };
}

test('grid adapter retains sheet IDs, dimensions, formulas, booleans and zero while omitting empty cells', () => {
  const { loaded } = harness();
  const grid: SheetGridModel = {
    kind: 'sheet',
    version: 1,
    activeSheetId: 'second',
    sheets: [
      {
        id: 'first',
        name: 'Plan',
        columnCount: 40,
        rowCount: 500,
        cells: {
          a1: { value: 0 },
          B2: { value: false },
          C3: { formula: '=SUM(A1:A2)', value: 900 },
          D4: { formula: '2+2' },
          E5: {},
          F6: { value: '' },
        },
      },
      { id: 'second', name: 'Small', columnCount: 2, rowCount: 3, cells: { A1: { value: 'Context' } } },
    ],
  };
  const data = workbookDataFromGrid(loaded.engine, grid);
  expect(data.sheets[0]).toMatchObject({
    id: 'first',
    name: 'Plan',
    colNumber: 40,
    rowNumber: 500,
    cells: { A1: '0', B2: 'false', C3: '=SUM(A1:A2)', D4: '=2+2' },
  });
  expect(data.sheets[1]).toMatchObject({
    id: 'second',
    name: 'Small',
    colNumber: 26,
    rowNumber: 100,
    cells: { A1: 'Context' },
  });
  const { session } = harness().create(grid);
  expect(session.snapshot().activeSheetId).toBe('second');
  expect(session.snapshot().workbook.sheets).toEqual(data.sheets);
});

test('grid migration preserves format-only cells and literal strings that resemble numbers, booleans or formulas', () => {
  const h = harness();
  const data = workbookDataFromGrid(h.loaded.engine, {
    kind: 'sheet',
    version: 1,
    sheets: [
      {
        id: 'typed',
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
          A12: { value: '' },
        },
      },
    ],
  });
  const sheet = data.sheets[0];
  expect(sheet.cells).toEqual({
    A1: '="=SUM(B1)"',
    A2: '="="&CHAR(34)&"unsafe"&CHAR(34)',
    A3: '001',
    A4: 'TRUE',
    A5: '1234.5',
    A6: '0.125',
    A7: '46275',
    A8: '1234.5',
    A10: '="001"',
    A11: '=A5*2',
  });
  const formats = data.formats as Record<string, string>;
  const cellFormats = sheet.formats as Record<string, number>;
  expect(
    Object.fromEntries(Object.entries(cellFormats).map(([address, id]) => [address, formats[id]])),
  ).toEqual({
    A1: '@',
    A2: '@',
    A3: '@',
    A4: '@',
    A5: '$#,##0.00',
    A6: '0.00%',
    A7: 'yyyy-mm-dd',
    A8: '#,##0.00',
    A9: '$#,##0.00',
    A10: '#,##0.00',
    A11: '$#,##0.00',
    A12: '@',
  });
});

test('session mounts the configured component, preserves full snapshots, switches mode and disposes once', async () => {
  const h = harness();
  const { session, model, notifyUser, raiseError, askConfirmation } = h.create(savedModel(), true);
  expect(h.config()).toMatchObject({ mode: 'readonly', client: { id: 'albatross-local', name: 'You' } });
  expect(session.snapshot()).toEqual(savedModel());
  const container = { replaceChildren: mock(() => undefined) } as unknown as HTMLElement;
  await session.mount(container);
  expect(container.replaceChildren).toHaveBeenCalledTimes(1);
  expect(h.apps[0].options).toMatchObject({
    templates: '<templates/>',
    dev: false,
    props: { model, notifyUser, raiseError, askConfirmation },
  });
  session.setReadOnly(true);
  expect(model.updateMode).not.toHaveBeenCalled();
  session.setReadOnly(false);
  session.setReadOnly(false);
  session.setReadOnly(true);
  expect(model.updateMode.mock.calls).toEqual([['normal'], ['readonly']]);
  await session.dispose();
  await session.dispose();
  session.setReadOnly(false);
  await session.mount(container);
  expect(model.updateMode).toHaveBeenCalledTimes(2);
  expect(model.leaveSession).toHaveBeenCalledTimes(1);
  expect(h.apps[0].destroy).toHaveBeenCalledTimes(1);
  expect(h.apps).toHaveLength(1);
});

test('disposing during asynchronous Owl mount does not crash or destroy the instance twice', async () => {
  let finishMount!: () => void;
  const mountGate = new Promise<void>((resolve) => {
    finishMount = resolve;
  });
  const h = harness({ mountGate });
  const { session, model } = h.create();
  const mounting = session.mount({ replaceChildren: () => undefined } as unknown as HTMLElement);
  await session.dispose();
  finishMount();
  await mounting;
  expect(h.apps[0].destroy).toHaveBeenCalledTimes(1);
  expect(model.leaveSession).toHaveBeenCalledTimes(1);
});

test('missing or already-active sheet IDs do not dispatch invalid activation', async () => {
  for (const activeSheetId of ['missing', 'stable-plan', undefined]) {
    const h = harness();
    const { session } = h.create({ ...savedModel(), activeSheetId });
    expect(h.calls).toEqual([]);
    expect(session.snapshot().activeSheetId).toBe('stable-plan');
    await session.dispose();
  }
});

test('transport reports only committed content, coalesces a burst and suppresses updates after disposal', async () => {
  const h = harness();
  const { session } = h.create();
  const transport = h.config().transportService!;
  await transport.sendMessage({ type: 'CLIENT_MOVED' });
  expect(h.changed).not.toHaveBeenCalled();
  await Promise.all(
    ['REMOTE_REVISION', 'REVISION_UNDONE', 'REVISION_REDONE'].map((type) => transport.sendMessage({ type })),
  );
  expect(h.changed).toHaveBeenCalledTimes(1);
  expect(h.sent).toEqual(['CLIENT_MOVED', 'REMOTE_REVISION', 'REVISION_UNDONE', 'REVISION_REDONE']);
  const pending = transport.sendMessage({ type: 'REMOTE_REVISION' });
  await session.dispose();
  await pending;
  expect(h.changed).toHaveBeenCalledTimes(1);
});

test('AI edits prefer stable sheet IDs, support existing names and create only explicitly requested sheets', () => {
  const h = harness();
  const { session, model } = h.create();
  const outcome = applySheetChangeSet(
    session,
    plan(
      [
        { sheet: 'stable-plan', cell: 'A1', content: '=2+2' },
        { sheet: 'Notes', cell: 'B3', content: 'Note' },
        { sheet: 'Next', cell: 'A1', content: 'Follow-up' },
      ],
      ['Plan', 'Next'],
    ),
  );
  expect(outcome).toEqual({ applied: 4, failed: [] });
  expect(model.data.sheets.map((sheet) => sheet.name)).toEqual(['Plan', 'Notes', 'Next']);
  expect(h.calls.filter((call) => call.type === 'UPDATE_CELL').map((call) => call.payload)).toEqual([
    { sheetId: 'stable-plan', col: 0, row: 0, content: '=2+2' },
    { sheetId: 'stable-notes', col: 1, row: 2, content: 'Note' },
    { sheetId: 'generated-1', col: 0, row: 0, content: 'Follow-up' },
  ]);
});

test('a stable ID wins over a different sheet with that name', () => {
  const h = harness();
  const source = savedModel();
  source.workbook.sheets[1].name = 'stable-plan';
  const { session } = h.create(source);
  expect(
    applySheetChangeSet(session, plan([{ sheet: 'stable-plan', cell: 'A1', content: 'Exact' }])).failed,
  ).toEqual([]);
  expect(h.calls.find((call) => call.type === 'UPDATE_CELL')?.payload.sheetId).toBe('stable-plan');
});

test('unknown sheet references cannot create guessed sheets and roll back preceding commands', () => {
  const h = harness();
  const { session, model } = h.create();
  const before = session.snapshot();
  const outcome = applySheetChangeSet(
    session,
    plan(
      [
        { sheet: 'Plan', cell: 'A1', content: 'First' },
        { sheet: 'guessed-id', cell: 'A1', content: 'Wrong sheet' },
      ],
      ['Explicit new sheet'],
    ),
  );
  expect(outcome.applied).toBe(0);
  expect(outcome.failed[0].reason).toContain('could not be found');
  expect(session.snapshot()).toEqual(before);
  expect(model.getters.getSheetIds()).toHaveLength(2);
  expect(h.calls.filter((call) => call.type === 'REQUEST_UNDO')).toHaveLength(2);
});

test('out-of-bounds or engine-rejected changes atomically roll back all applied steps', () => {
  const h = harness({
    reject: (type, payload) =>
      type === 'UPDATE_CELL' && payload.content === 'reject' ? ['ProtectedCell', 'InvalidValue'] : undefined,
  });
  const { session } = h.create();
  const before = session.snapshot();
  const outcome = applySheetChangeSet(
    session,
    plan([
      { sheet: 'Plan', cell: 'A1', content: 'Changed' },
      { sheet: 'Plan', cell: 'AA1', content: 'Outside columns' },
      { sheet: 'Notes', cell: 'A101', content: 'Outside rows' },
      { sheet: 'Plan', cell: 'B1', content: 'reject' },
    ]),
  );
  expect(outcome.applied).toBe(0);
  expect(outcome.failed.map((failure) => failure.reason)).toEqual([
    'Cell is outside the sheet.',
    'Cell is outside the sheet.',
    'Rejected by the engine (ProtectedCell, InvalidValue).',
  ]);
  expect(session.snapshot()).toEqual(before);
});

test('failed explicit sheet creation is reported; no-change commands add no undo steps', () => {
  const h = harness({
    reject: (type) =>
      type === 'CREATE_SHEET' ? ['InvalidName'] : type === 'UPDATE_CELL' ? ['NoChanges'] : undefined,
  });
  const { session } = h.create();
  expect(applySheetChangeSet(session, plan([{ sheet: 'Plan', cell: 'A1', content: 'Same' }]))).toEqual({
    applied: 0,
    failed: [],
  });
  const outcome = applySheetChangeSet(
    session,
    plan([{ sheet: 'Uncreated', cell: 'A1', content: 'Value' }], ['Uncreated']),
  );
  expect(outcome.failed).toHaveLength(2);
  expect(outcome.failed[0].reason).toBe('Sheet could not be created.');
  expect(h.calls.some((call) => call.type === 'REQUEST_UNDO')).toBe(false);
});

async function xlsxArchive(
  extra: Record<string, string> = {},
  contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
) {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<Types><Override PartName="/xl/workbook.xml" ContentType="${contentType}"/></Types>`,
  );
  zip.file('xl/workbook.xml', '<workbook/>');
  for (const [path, content] of Object.entries(extra)) zip.file(path, content);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

test('XLSX import validates bytes, skips images, passes actual XML to engine and deduplicates warnings', async () => {
  const h = harness();
  h.load.mockImplementation(() => {
    console.warn('Unsupported chart', { kind: 'radar' });
    console.warn('Unsupported chart', { kind: 'radar' });
    return initialWorkbook();
  });
  const originalWarn = console.warn;
  const bytes = await xlsxArchive({
    'xl/worksheets/sheet1.xml': '<worksheet/>',
    'xl/media/image1.png': 'synthetic image',
  });
  const result = await importXlsxWorkbook(h.loaded, new Blob([bytes]));
  expect(result.bytes).toEqual(bytes);
  expect(result.workbook).toEqual(initialWorkbook());
  expect(result.skipped).toEqual(['xl/media/image1.png']);
  expect(result.warnings).toEqual([
    '1 embedded image(s) were not imported.',
    'Unsupported chart {"kind":"radar"}',
  ]);
  expect(h.load.mock.calls[0][0]['xl/worksheets/sheet1.xml']).toBe('<worksheet/>');
  expect(h.load.mock.calls[0][0]['xl/media/image1.png']).toBeUndefined();
  expect(h.load.mock.calls[0][1]).toBe(true);
  expect(console.warn).toBe(originalWarn);
});

test('XLSX import failures never leak temporary warning interception or invoke engine on unsafe input', async () => {
  const h = harness();
  await expect(
    importXlsxWorkbook(h.loaded, new Blob([new Uint8Array(MAX_XLSX_BYTES + 1)])),
  ).rejects.toMatchObject({ status: 413 });
  await expect(importXlsxWorkbook(h.loaded, new Blob(['not a workbook']))).rejects.toThrow();
  await expect(
    importXlsxWorkbook(
      h.loaded,
      new Blob([await xlsxArchive({}, 'application/vnd.ms-excel.sheet.macroEnabled.main+xml')]),
    ),
  ).rejects.toThrow();
  expect(h.load).not.toHaveBeenCalled();
  const originalWarn = console.warn;
  h.load.mockImplementation(() => {
    console.warn('Partial parse');
    throw new Error('Engine rejected workbook');
  });
  await expect(importXlsxWorkbook(h.loaded, new Blob([await xlsxArchive()]))).rejects.toThrow(
    'Engine rejected workbook',
  );
  expect(console.warn).toBe(originalWarn);
});

test('XLSX export packs current live engine XML and removes empty namespace artifacts', async () => {
  const { session, model } = harness().create();
  model.files = {
    name: 'Current',
    files: [
      { path: '[Content_Types].xml', content: '<Types xmlns=""/>' },
      { path: 'xl/worksheets/sheet1.xml', content: '<worksheet xmlns=""><c><v>42</v></c></worksheet>' },
    ],
  };
  const blob = await exportXlsxBlob(session.model);
  expect(blob.type).toBe(XLSX_MIME);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  expect(await zip.file('xl/worksheets/sheet1.xml')!.async('string')).toBe(
    '<worksheet><c><v>42</v></c></worksheet>',
  );
  model.files.files[1] = { path: 'xl/worksheets/sheet1.xml', content: '<worksheet>43</worksheet>' };
  const second = await JSZip.loadAsync(await (await exportXlsxBlob(session.model)).arrayBuffer());
  expect(await second.file('xl/worksheets/sheet1.xml')!.async('string')).toBe('<worksheet>43</worksheet>');
});

test('download creates a named browser action and revokes its temporary URL after the click', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const oldCreate = URL.createObjectURL;
  const oldRevoke = URL.revokeObjectURL;
  const oldTimeout = globalThis.setTimeout;
  const anchor = { href: '', download: '', click: mock(() => undefined) };
  let cleanup: (() => void) | undefined;
  const revoke = mock((_url: string) => undefined);
  try {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        createElement: (tag: string) => {
          expect(tag).toBe('a');
          return anchor;
        },
      },
    });
    URL.createObjectURL = mock(() => 'blob:synthetic-download');
    URL.revokeObjectURL = revoke;
    globalThis.setTimeout = ((callback: () => void, delay: number) => {
      expect(delay).toBe(1000);
      cleanup = callback;
      return 1;
    }) as unknown as typeof setTimeout;
    downloadBlob(new Blob(['xlsx']), 'Plan.xlsx');
    expect(anchor.href).toBe('blob:synthetic-download');
    expect(anchor.download).toBe('Plan.xlsx');
    expect(anchor.click).toHaveBeenCalledTimes(1);
    expect(revoke).not.toHaveBeenCalled();
    cleanup!();
    expect(revoke).toHaveBeenCalledWith('blob:synthetic-download');
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'document', descriptor);
    else Reflect.deleteProperty(globalThis, 'document');
    URL.createObjectURL = oldCreate;
    URL.revokeObjectURL = oldRevoke;
    globalThis.setTimeout = oldTimeout;
  }
});
