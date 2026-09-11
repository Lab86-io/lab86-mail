/**
 * Hand-written declaration for the pinned @odoo/o-spreadsheet 19.0.x runtime.
 *
 * The published npm package points its `main`/`module` fields at files that are
 * not in the tarball (`dist/o-spreadsheet.esm.js`); the shipped bundle is
 * `dist/o_spreadsheet.esm.js` and no `dist/types` directory is published, so we
 * import the deep path and describe only the surface we use. Every member
 * below was verified against the 19.0 branch sources:
 *   src/model.ts, src/migrations/data.ts, src/index.ts,
 *   src/collaborative/local_transport_service.ts, src/helpers/event_bus.ts,
 *   src/components/spreadsheet/spreadsheet.ts, src/types/workbook_data.ts.
 */
declare module '@odoo/o-spreadsheet/dist/o_spreadsheet.esm.js' {
  export interface OdooSheetData {
    id: string;
    name: string;
    colNumber: number;
    rowNumber: number;
    cells: { [xc: string]: string | undefined };
    isVisible?: boolean;
    [key: string]: unknown;
  }

  export interface OdooWorkbookData {
    version: string;
    sheets: OdooSheetData[];
    revisionId: string;
    [key: string]: unknown;
  }

  export type OdooXlsxExportFile = { path: string; content: string } | { path: string; imageSrc: string };

  export interface OdooXlsxExport {
    name: string;
    files: OdooXlsxExportFile[];
  }

  export interface OdooNotification {
    text: string;
    type: 'danger' | 'info' | 'success' | 'warning';
    sticky: boolean;
  }

  export interface OdooCollaborationMessage {
    type: string;
    [key: string]: unknown;
  }

  export interface OdooTransportService {
    sendMessage(message: OdooCollaborationMessage): void | Promise<void>;
    onNewMessage(id: string, callback: (message: OdooCollaborationMessage) => void): void;
    leave(id: string): void;
  }

  export class LocalTransportService implements OdooTransportService {
    sendMessage(message: OdooCollaborationMessage): Promise<void>;
    onNewMessage(id: string, callback: (message: OdooCollaborationMessage) => void): void;
    leave(id: string): void;
  }

  export type OdooMode = 'normal' | 'readonly' | 'dashboard';

  export interface OdooModelConfig {
    mode?: OdooMode;
    transportService?: OdooTransportService;
    client?: { id: string; name: string };
    snapshotRequested?: boolean;
    external?: Record<string, unknown>;
    custom?: Record<string, unknown>;
  }

  export interface OdooDispatchResult {
    isSuccessful: boolean;
    reasons: Array<string | number>;
  }

  export interface OdooGetters {
    getActiveSheetId(): string;
    getSheetIds(): string[];
    getSheetName(sheetId: string): string;
    getSheetIdByName(name: string): string | undefined;
    getNumberCols(sheetId: string): number;
    getNumberRows(sheetId: string): number;
    isReadonly(): boolean;
    [getter: string]: (...args: any[]) => any;
  }

  export class Model {
    constructor(data?: unknown, config?: OdooModelConfig, stateUpdateMessages?: unknown[]);
    getters: OdooGetters;
    dispatch(type: string, payload?: Record<string, unknown>): OdooDispatchResult;
    canDispatch(type: string, payload?: Record<string, unknown>): OdooDispatchResult;
    exportData(): OdooWorkbookData;
    exportXLSX(): OdooXlsxExport;
    joinSession(): void;
    leaveSession(): Promise<void>;
    updateMode(mode: OdooMode): void;
    on(type: string, owner: unknown, callback: (payload?: unknown) => void): void;
    off(type: string, owner: unknown): void;
  }

  /** Owl component class; typed loosely because Owl generics are not needed here. */
  export const Spreadsheet: any;

  export function load(data?: unknown, verboseImport?: boolean): OdooWorkbookData;

  export const helpers: {
    createEmptyWorkbookData(sheetName?: string): OdooWorkbookData;
    createEmptySheet(sheetId: string, name: string): OdooSheetData;
    toXC(col: number, row: number): string;
    toCartesian(xc: string): { col: number; row: number };
    numberToLetters(n: number): string;
    lettersToNumber(letters: string): number;
    UuidGenerator: new () => { uuidv4(): string };
    [helper: string]: unknown;
  };

  export const __info__: { version: string; date: string; hash: string };
}
