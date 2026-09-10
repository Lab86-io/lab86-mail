/**
 * Engine-backed spreadsheet model (version 2 of the `sheet` kind).
 *
 * The canonical persisted form is the FULL tagged snapshot produced by
 * o-spreadsheet's `Model.exportData()` (its `WorkbookData`), never a lossy
 * conversion through the version 1 grid. Version 1 sheets remain readable and
 * are upgraded in the browser the first time they are opened in the engine.
 *
 * This module is isomorphic: it must not import the engine bundle, because the
 * server projects workbooks into text, Excel, and Google Sheets without it.
 */
import { z } from 'zod';

export const ODOO_SPREADSHEET_ENGINE = 'o-spreadsheet' as const;
/** Pinned engine release; tests assert this matches package.json and public/vendor. */
export const ODOO_SPREADSHEET_VERSION = '19.0.50';
export const ODOO_OWL_VERSION = '2.8.2';
export const ODOO_OWL_ASSET_BASE = `/vendor/owl/${ODOO_OWL_VERSION}`;
export const ODOO_SPREADSHEET_ASSET_BASE = `/vendor/o-spreadsheet/${ODOO_SPREADSHEET_VERSION}`;
export const FONT_AWESOME_ASSET_BASE = '/vendor/font-awesome-4.7.0';
/** Convex documents are capped at 1 MiB; keep room for the row's other fields. */
export const MAX_DOCUMENT_MODEL_BYTES = 900_000;
export const MAX_WORKBOOK_SHEETS = 200;
export const MAX_SHEET_CHANGES = 500;

const workbookSheetSchema = z
  .object({
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    colNumber: z.number().int().min(1).max(20_000),
    rowNumber: z.number().int().min(1).max(1_000_000),
    cells: z.record(z.string().max(24), z.string().max(100_000).optional()).optional(),
    isVisible: z.boolean().optional(),
  })
  .passthrough();

export const workbookDataSchema = z
  .object({
    version: z.union([z.string().max(40), z.number()]),
    sheets: z.array(workbookSheetSchema).min(1).max(MAX_WORKBOOK_SHEETS),
    revisionId: z.string().max(200).optional(),
  })
  .passthrough();

export const sheetWorkbookModelSchema = z.object({
  kind: z.literal('sheet'),
  version: z.literal(2),
  engine: z.literal(ODOO_SPREADSHEET_ENGINE),
  engineVersion: z.string().min(1).max(40),
  workbook: workbookDataSchema,
  activeSheetId: z.string().max(200).optional(),
});

export type SheetWorkbookModel = z.infer<typeof sheetWorkbookModelSchema>;
export type WorkbookData = z.infer<typeof workbookDataSchema>;
export type WorkbookSheetData = z.infer<typeof workbookSheetSchema>;

/**
 * AI proposals for engine-backed sheets are cell-level change sets, applied in
 * the editor through engine commands. The server never rewrites a workbook
 * snapshot it cannot evaluate.
 */
export const sheetChangeSchema = z.object({
  sheet: z.string().min(1).max(200),
  cell: z
    .string()
    .regex(/^[A-Z]{1,3}[1-9]\d{0,6}$/u, 'Cell must be an A1 reference such as B7.')
    .max(12),
  content: z.string().max(10_000),
});

export const sheetChangeSetSchema = z.object({
  kind: z.literal('sheet-changes'),
  version: z.literal(1),
  changes: z.array(sheetChangeSchema).min(1).max(MAX_SHEET_CHANGES),
  newSheets: z.array(z.string().min(1).max(200)).max(20).optional(),
});

export type SheetChange = z.infer<typeof sheetChangeSchema>;
export type SheetChangeSet = z.infer<typeof sheetChangeSetSchema>;

export interface DocumentImportSource {
  format: 'xlsx';
  filename: string;
  mimeType: string;
  size: number;
  sha256: string;
  storageId: string;
  warnings: string[];
  importedAt: number;
  /** Revision that holds the engine's reading of the original bytes. */
  revision: number;
}

export function isSheetWorkbookModel(model: unknown): model is SheetWorkbookModel {
  return (
    typeof model === 'object' &&
    model !== null &&
    (model as { kind?: unknown }).kind === 'sheet' &&
    (model as { version?: unknown }).version === 2
  );
}

export function isSheetChangeSet(value: unknown): value is SheetChangeSet {
  return (
    typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'sheet-changes'
  );
}

export function columnLetters(index: number) {
  let value = index;
  let out = '';
  while (value > 0) {
    value -= 1;
    out = String.fromCharCode(65 + (value % 26)) + out;
    value = Math.floor(value / 26);
  }
  return out;
}

export function parseCellAddress(address: string) {
  const match = /^([A-Z]+)(\d+)$/iu.exec(address);
  if (!match) return null;
  let column = 0;
  for (const character of match[1].toUpperCase()) column = column * 26 + character.charCodeAt(0) - 64;
  return { column, row: Number(match[2]) };
}

/** Stable, sorted (sheet, address, content) triples for text projections and diffs. */
export function workbookCellEntries(workbook: WorkbookData) {
  return workbook.sheets.map((sheet) => ({
    id: sheet.id,
    name: sheet.name,
    cells: Object.entries(sheet.cells || {})
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '')
      .map(([address, content]) => ({ address, content, position: parseCellAddress(address) }))
      .filter((cell) => cell.position !== null)
      .sort(
        (left, right) =>
          left.position!.row - right.position!.row || left.position!.column - right.position!.column,
      ),
  }));
}

export function workbookText(model: SheetWorkbookModel, options: { maxCells?: number } = {}) {
  const maxCells = options.maxCells ?? 20_000;
  const lines: string[] = [];
  let count = 0;
  for (const sheet of workbookCellEntries(model.workbook)) {
    lines.push(sheet.name);
    for (const cell of sheet.cells) {
      if (count >= maxCells) {
        lines.push('…');
        return lines.join('\n');
      }
      lines.push(`${cell.address}: ${cell.content}`);
      count += 1;
    }
  }
  return lines.join('\n');
}

/**
 * Lossy projection used only where a version 1 grid is the interface (Google
 * Sheets sync, server-side Excel fallback, native clients). Styles, formats,
 * charts, pivots, merges, and validation are NOT carried; callers must say so.
 */
export function projectWorkbookToSheetV1(
  model: SheetWorkbookModel,
  limits: {
    maxRows: number;
    maxColumns: number;
    maxCells: number;
  },
) {
  const sheets = workbookCellEntries(model.workbook).map((sheet, index) => {
    const source = model.workbook.sheets[index];
    const cells: Record<string, { value?: string | number | boolean; formula?: string }> = {};
    let stored = 0;
    for (const cell of sheet.cells) {
      if (stored >= limits.maxCells) break;
      const { row, column } = cell.position!;
      if (row > limits.maxRows || column > limits.maxColumns) continue;
      if (cell.content.startsWith('=')) cells[cell.address] = { formula: cell.content.slice(1) };
      else {
        const numeric = Number(cell.content);
        cells[cell.address] = {
          value: cell.content.trim() !== '' && Number.isFinite(numeric) ? numeric : cell.content,
        };
      }
      stored += 1;
    }
    return {
      id: sheet.id,
      name: sheet.name,
      rowCount: Math.min(limits.maxRows, Math.max(1, source.rowNumber)),
      columnCount: Math.min(limits.maxColumns, Math.max(1, source.colNumber)),
      cells,
    };
  });
  return {
    kind: 'sheet' as const,
    version: 1 as const,
    activeSheetId: sheets.find((sheet) => sheet.id === model.activeSheetId)?.id || sheets[0]?.id || 'sheet-1',
    sheets: sheets.length
      ? sheets
      : [{ id: 'sheet-1', name: 'Sheet 1', rowCount: 100, columnCount: 26, cells: {} }],
  };
}

export function modelByteLength(model: unknown) {
  return new TextEncoder().encode(JSON.stringify(model)).byteLength;
}

export class DocumentTooLargeError extends Error {
  constructor(bytes: number) {
    super(
      `This file is ${Math.round(bytes / 1024)} KB, above the ${Math.round(MAX_DOCUMENT_MODEL_BYTES / 1024)} KB limit for a saved revision. Remove data or split the workbook.`,
    );
    this.name = 'DocumentTooLargeError';
  }
}

export function assertModelWithinLimit(model: unknown) {
  const bytes = modelByteLength(model);
  if (bytes > MAX_DOCUMENT_MODEL_BYTES) throw new DocumentTooLargeError(bytes);
  return bytes;
}
