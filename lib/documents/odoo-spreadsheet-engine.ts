/**
 * Browser-only loader and session factory for the pinned o-spreadsheet engine.
 *
 * Upstream contract (doc/integrating/integration.md on the 19.0 branch): mount
 * the Owl `Spreadsheet` component with a `Model` and the XML templates; the
 * model takes `(data, config, stateUpdateMessages)`, exports its full state with
 * `exportData()`, exports Excel parts with `exportXLSX()`, and must be left with
 * `leaveSession()`. Excel import is `load(files)` where `files` maps zip entry
 * paths to their text (demo/main.js on 19.0). Nothing here is invented.
 */

import type {
  Model,
  OdooNotification,
  OdooWorkbookData,
} from '@odoo/o-spreadsheet/dist/o_spreadsheet.esm.js';
import type { App as OwlApp } from '@odoo/owl';
import type { SheetGridModel } from './model';
import {
  FONT_AWESOME_ASSET_BASE,
  ODOO_OWL_ASSET_BASE,
  ODOO_SPREADSHEET_ASSET_BASE,
  ODOO_SPREADSHEET_ENGINE,
  ODOO_SPREADSHEET_VERSION,
  type SheetChangeSet,
  type SheetWorkbookModel,
} from './sheet-workbook';
import { spreadsheetImageStore } from './spreadsheet-image-store';
import {
  assertSupportedContentTypes,
  inflateEntryText,
  inspectXlsxContainer,
  MAX_XLSX_BYTES,
  MAX_XLSX_ENTRY_BYTES,
  XLSX_MIME,
  XlsxImportError,
} from './xlsx-validation';

export { XLSX_MIME, XlsxImportError };

type EngineModule = typeof import('@odoo/o-spreadsheet/dist/o_spreadsheet.esm.js');
type OwlModule = typeof import('@odoo/owl');

export interface LoadedEngine {
  engine: EngineModule;
  owl: OwlModule;
  templates: string;
}

export const SPREADSHEET_STYLESHEETS = [
  `${ODOO_SPREADSHEET_ASSET_BASE}/dist/bootstrap-subset.css`,
  `${FONT_AWESOME_ASSET_BASE}/css/font-awesome.css`,
  `${ODOO_SPREADSHEET_ASSET_BASE}/dist/o_spreadsheet.css`,
];
export const SPREADSHEET_TEMPLATES_URL = `${ODOO_SPREADSHEET_ASSET_BASE}/dist/o_spreadsheet.xml`;

/** Session messages that change workbook content (src/collaborative/session.ts). */
const CONTENT_MESSAGE_TYPES = new Set(['REMOTE_REVISION', 'REVISION_UNDONE', 'REVISION_REDONE']);

let loading: Promise<LoadedEngine> | null = null;

export const SPREADSHEET_CHART_SCRIPTS = [
  'chart.umd.js',
  'chart-geo.umd.js',
  'luxon.min.js',
  'chart-luxon.umd.js',
  'chart-treemap.js',
];
let chartLoading: Promise<void> | null = null;
export function loadChartLibraries(): Promise<void> {
  chartLoading ??= (async () => {
    // UMD add-ons register against Chart, and the date adapter requires Luxon.
    for (const filename of SPREADSHEET_CHART_SCRIPTS) {
      if (document.querySelector(`script[data-sheet-chart="${filename}"]`)) continue;
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        script.src = `/vendor/spreadsheet-charts/${filename}`;
        script.onload = () => {
          script.dataset.sheetChart = filename;
          resolve();
        };
        script.onerror = () => {
          script.remove();
          reject(new Error(`Could not load chart library ${filename}.`));
        };
        document.head.appendChild(script);
      });
    }
  })().catch((error) => {
    chartLoading = null;
    throw error;
  });
  return chartLoading;
}

function ensureStylesheet(href: string) {
  const existing = document.querySelector<HTMLLinkElement>(`link[data-albatross-sheet="${href}"]`);
  if (existing) {
    return existing.dataset.loaded === 'true'
      ? Promise.resolve()
      : new Promise<void>((resolve, reject) => {
          existing.addEventListener('load', () => resolve(), { once: true });
          existing.addEventListener('error', () => reject(new Error(`Could not load ${href}`)), {
            once: true,
          });
        });
  }
  return new Promise<void>((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.albatrossSheet = href;
    link.addEventListener(
      'load',
      () => {
        link.dataset.loaded = 'true';
        resolve();
      },
      { once: true },
    );
    link.addEventListener(
      'error',
      () => {
        link.remove();
        reject(new Error(`The spreadsheet styles could not be loaded (${href}).`));
      },
      { once: true },
    );
    document.head.appendChild(link);
  });
}

export function loadSpreadsheetEngine(): Promise<LoadedEngine> {
  if (!loading) {
    loading = (async () => {
      const [engine, owl, templates] = await Promise.all([
        // Separate, same-origin ESM keeps the LGPL libraries replaceable without
        // rebuilding or modifying Albatross's application chunks.
        import(
          /* webpackIgnore: true */ `${ODOO_SPREADSHEET_ASSET_BASE}/dist/o_spreadsheet.esm.js`
        ) as Promise<EngineModule>,
        import(/* webpackIgnore: true */ `${ODOO_OWL_ASSET_BASE}/dist/owl.es.js`) as Promise<OwlModule>,
        fetch(SPREADSHEET_TEMPLATES_URL, { cache: 'force-cache' }).then(async (response) => {
          if (!response.ok) throw new Error('The spreadsheet templates could not be loaded.');
          return response.text();
        }),
        Promise.all(SPREADSHEET_STYLESHEETS.map(ensureStylesheet)),
        loadChartLibraries(),
      ]);
      if (engine.__info__.version !== ODOO_SPREADSHEET_VERSION) {
        throw new Error(
          `Spreadsheet engine mismatch: bundle ${engine.__info__.version}, assets ${ODOO_SPREADSHEET_VERSION}.`,
        );
      }
      engine.registries.topbarMenuRegistry.addChild('albatross_source', ['file'], {
        name: 'About spreadsheet',
        sequence: 900,
        isReadonlyAllowed: true,
        execute: () =>
          window.open(`${ODOO_SPREADSHEET_ASSET_BASE}/NOTICE.md`, '_blank', 'noopener,noreferrer'),
      });
      return { engine, owl, templates };
    })().catch((error) => {
      loading = null;
      throw error;
    });
  }
  return loading;
}

const GRID_NUMBER_FORMATS = {
  text: '@',
  number: '#,##0.00',
  currency: '$#,##0.00',
  percent: '0.00%',
  date: 'yyyy-mm-dd',
} as const;

function constantTextFormula(value: string) {
  // Odoo's formula parser does not use Excel's doubled-quote escaping. CHAR
  // segments work in both engines, including trailing backslashes/newlines,
  // and never allow user text to become executable expression syntax.
  return `=${value
    .split(/(["\\\r\n])/u)
    .filter(Boolean)
    .map((part) => (/^["\\\r\n]$/u.test(part) ? `CHAR(${part.charCodeAt(0)})` : `"${part}"`))
    .join('&')}`;
}

/** Upgrade a version 1 grid without reinterpreting literal values as formulas. */
export function workbookDataFromGrid(engine: EngineModule, grid: SheetGridModel): OdooWorkbookData {
  const data = engine.helpers.createEmptyWorkbookData(grid.sheets[0]?.name || 'Sheet1');
  const formats: Record<string, string> = {};
  const formatIds = new Map<string, number>();
  data.sheets = grid.sheets.map((tab) => {
    const sheet = engine.helpers.createEmptySheet(tab.id, tab.name);
    const cells: Record<string, string> = {};
    const sheetFormats: Record<string, number> = {};
    for (const [address, cell] of Object.entries(tab.cells)) {
      const isLiteralString = !cell.formula && typeof cell.value === 'string';
      const format = cell.format ? GRID_NUMBER_FORMATS[cell.format] : isLiteralString ? '@' : undefined;
      const xc = address.toUpperCase();
      if (format) {
        let id = formatIds.get(format);
        if (!id) {
          id = formatIds.size + 1;
          formatIds.set(format, id);
          formats[id] = format;
        }
        sheetFormats[xc] = id;
      }
      let content = cell.formula ? `=${cell.formula.replace(/^=/u, '')}` : cell.value;
      if (content === undefined || content === '') continue;
      if (isLiteralString && (String(content).startsWith('=') || format !== '@')) {
        // Odoo treats '=' as formula even with text formatting, and numeric
        // formats otherwise parse numeric-looking strings. A constant-string
        // expression preserves the exact typed value without executing it.
        content = constantTextFormula(String(content));
      }
      cells[xc] = String(content);
    }
    return {
      ...sheet,
      colNumber: Math.max(sheet.colNumber, tab.columnCount),
      rowNumber: Math.max(sheet.rowNumber, tab.rowCount),
      cells,
      formats: sheetFormats,
    };
  });
  data.formats = formats;
  return data;
}

export function workbookModelFromEngine(model: Model, engine: EngineModule): SheetWorkbookModel {
  return {
    kind: 'sheet',
    version: 2,
    engine: ODOO_SPREADSHEET_ENGINE,
    engineVersion: engine.__info__.version,
    workbook: model.exportData(),
    activeSheetId: model.getters.getActiveSheetId(),
  };
}

export interface SpreadsheetSessionOptions {
  loaded: LoadedEngine;
  model: SheetGridModel | SheetWorkbookModel;
  readOnly?: boolean;
  onContentChange: () => void;
  notifyUser?: (notification: OdooNotification) => void;
  raiseError?: (text: string, callback?: () => void) => void;
  askConfirmation?: (content: string, confirm: () => void, cancel?: () => void) => void;
}

export interface SpreadsheetSession {
  model: Model;
  engine: EngineModule;
  mount(container: HTMLElement): Promise<void>;
  setReadOnly(readOnly: boolean): void;
  snapshot(): SheetWorkbookModel;
  dispose(): Promise<void>;
}

export function createSpreadsheetSession(options: SpreadsheetSessionOptions): SpreadsheetSession {
  const { engine, owl, templates } = options.loaded;
  let changeScheduled = false;
  let disposed = false;
  const reportChange = () => {
    if (changeScheduled || disposed) return;
    changeScheduled = true;
    queueMicrotask(() => {
      changeScheduled = false;
      if (!disposed) options.onContentChange();
    });
  };
  class ReportingTransport extends engine.LocalTransportService {
    async sendMessage(message: { type: string }) {
      await super.sendMessage(message);
      if (CONTENT_MESSAGE_TYPES.has(message.type)) reportChange();
    }
  }
  const data =
    options.model.version === 2 ? options.model.workbook : workbookDataFromGrid(engine, options.model);
  const model = new engine.Model(data, {
    mode: options.readOnly ? 'readonly' : 'normal',
    transportService: new ReportingTransport(),
    client: { id: 'albatross-local', name: 'You' },
    external: { fileStore: spreadsheetImageStore },
  });
  const wanted = options.model.version === 2 ? options.model.activeSheetId : options.model.activeSheetId;
  if (wanted && model.getters.getSheetIds().includes(wanted)) {
    const current = model.getters.getActiveSheetId();
    if (current !== wanted) model.dispatch('ACTIVATE_SHEET', { sheetIdFrom: current, sheetIdTo: wanted });
  }
  let app: OwlApp | null = null;
  return {
    model,
    engine,
    async mount(container) {
      if (disposed) return;
      container.replaceChildren();
      const mountedApp = new owl.App(engine.Spreadsheet, {
        name: 'Albatross spreadsheet',
        // Keep the complete spreadsheet menus available beside the chat panel.
        env: { isSmall: false },
        props: {
          model,
          notifyUser: options.notifyUser,
          raiseError: options.raiseError,
          askConfirmation: options.askConfirmation,
        },
        templates,
        dev: false,
        warnIfNoStaticProps: false,
      });
      app = mountedApp;
      // dispose() may run while Owl is mounting. It owns destruction and clears
      // app; retain this instance locally instead of dereferencing app afterward.
      await mountedApp.mount(container);
    },
    setReadOnly(readOnly) {
      if (disposed) return;
      const isReadonly = model.getters.isReadonly();
      if (readOnly !== isReadonly) model.updateMode(readOnly ? 'readonly' : 'normal');
    },
    snapshot: () => workbookModelFromEngine(model, engine),
    async dispose() {
      if (disposed) return;
      disposed = true;
      app?.destroy();
      app = null;
      await model.leaveSession();
    },
  };
}

export interface XlsxImportResult {
  workbook: OdooWorkbookData;
  warnings: string[];
  skipped: string[];
  /** Untouched bytes that were validated and read; upload exactly these. */
  bytes: Uint8Array;
}

/**
 * Validate, unpack, and let the engine read an .xlsx (demo/main.js "Import
 * XLSX", 19.0). The container is inspected without inflating first (entry
 * count, declared sizes, encryption, macros, hostile paths), then every part is
 * inflated through a byte-counting stream so a lying directory record cannot
 * freeze the tab. Embedded images are skipped because Albatross has no file
 * store the engine could upload them to.
 */
export async function importXlsxWorkbook(loaded: LoadedEngine, file: Blob): Promise<XlsxImportResult> {
  if (file.size > MAX_XLSX_BYTES) throw new XlsxImportError('Workbooks above 15 MB cannot be imported.', 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const container = inspectXlsxContainer(bytes);
  const { default: JSZip } = await import('jszip');
  // checkCRC32 eagerly inflates every member before our bounded streams run.
  // Keep it disabled; inspect metadata first, then bound each actual inflation.
  const zip = await new JSZip().loadAsync(bytes).catch(() => {
    throw new XlsxImportError(
      'The workbook archive could not be read. Save a fresh .xlsx copy and try again.',
    );
  });
  const contentTypes = zip.file('[Content_Types].xml');
  if (!contentTypes) throw new XlsxImportError('This file is not an Excel workbook (.xlsx).');
  assertSupportedContentTypes(await inflateEntryText(contentTypes, 1024 * 1024));
  const files: Record<string, string> = {};
  const skipped: string[] = [];
  for (const entry of container.entries) {
    const zipEntry = zip.file(entry.name);
    if (!zipEntry || zipEntry.dir) continue;
    if (entry.name.includes('media/image')) {
      // Images need a file store the engine can upload to; Albatross has none yet.
      skipped.push(entry.name);
      continue;
    }
    files[entry.name] = await inflateEntryText(
      zipEntry,
      Math.min(MAX_XLSX_ENTRY_BYTES, entry.uncompressedSize + 1024),
    );
  }
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  };
  let workbook: OdooWorkbookData;
  try {
    workbook = loaded.engine.load(files, true);
  } finally {
    console.warn = originalWarn;
  }
  if (skipped.length) warnings.unshift(`${skipped.length} embedded image(s) were not imported.`);
  return { workbook, warnings: [...new Set(warnings)], skipped, bytes };
}

/** Build an .xlsx from the live engine (demo/main.js "Save as XLSX", 19.0). */
export async function exportXlsxBlob(model: Model): Promise<Blob> {
  const { default: JSZip } = await import('jszip');
  const exported = model.exportXLSX();
  const zip = new JSZip();
  for (const file of exported.files) {
    if ('imageSrc' in file) {
      const response = await fetch(file.imageSrc);
      zip.file(file.path, await response.blob());
    } else {
      zip.file(file.path, file.content.replaceAll(' xmlns=""', ''));
    }
  }
  return zip.generateAsync({ type: 'blob', mimeType: XLSX_MIME });
}

export interface ChangeSetOutcome {
  applied: number;
  failed: Array<{ sheet: string; cell: string; reason: string }>;
}

/**
 * Apply an AI change set through engine commands. Every UPDATE_CELL is a
 * separate undoable step; on any failure the applied steps are undone so the
 * workbook is never left half-changed.
 */
export function applySheetChangeSet(
  session: SpreadsheetSession,
  changeSet: SheetChangeSet,
): ChangeSetOutcome {
  const { model, engine } = session;
  const uuid = new engine.helpers.UuidGenerator();
  const failed: ChangeSetOutcome['failed'] = [];
  let applied = 0;
  const findSheet = (reference: string) =>
    model.getters.getSheetIds().includes(reference) ? reference : model.getters.getSheetIdByName(reference);
  const ensureSheet = (name: string) => {
    const existing = findSheet(name);
    if (existing) return existing;
    const sheetId = uuid.uuidv4();
    const result = model.dispatch('CREATE_SHEET', {
      sheetId,
      name,
      position: model.getters.getSheetIds().length,
    });
    if (!result.isSuccessful) return null;
    applied += 1;
    return sheetId;
  };
  for (const name of changeSet.newSheets || []) {
    if (!ensureSheet(name)) failed.push({ sheet: name, cell: '', reason: 'Sheet could not be created.' });
  }
  for (const change of changeSet.changes) {
    // Structured tools use stable IDs; natural-language proposals may use a
    // current name. Neither may silently create a guessed sheet. Creation is
    // authorized only by the explicit newSheets portion of the reviewed plan.
    const sheetId = findSheet(change.sheet);
    if (!sheetId) {
      failed.push({ ...change, reason: 'Sheet could not be found. Add it to newSheets before editing.' });
      continue;
    }
    const { col, row } = engine.helpers.toCartesian(change.cell);
    if (col >= model.getters.getNumberCols(sheetId) || row >= model.getters.getNumberRows(sheetId)) {
      failed.push({ ...change, reason: 'Cell is outside the sheet.' });
      continue;
    }
    const result = model.dispatch('UPDATE_CELL', { sheetId, col, row, content: change.content });
    if (result.isSuccessful) applied += 1;
    else if (result.reasons.length && result.reasons.every((reason) => String(reason) === 'NoChanges'))
      continue;
    else failed.push({ ...change, reason: `Rejected by the engine (${result.reasons.join(', ')}).` });
  }
  if (failed.length) {
    for (let index = 0; index < applied; index += 1) model.dispatch('REQUEST_UNDO');
    return { applied: 0, failed };
  }
  return { applied, failed };
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
