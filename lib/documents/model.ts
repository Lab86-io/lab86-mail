import { z } from 'zod';
import {
  type DocumentImportSource,
  isSheetChangeSet,
  isSheetWorkbookModel,
  projectWorkbookToSheetV1,
  type SheetChangeSet,
  type SheetWorkbookModel,
  sheetChangeSetSchema,
  sheetWorkbookModelSchema,
  workbookText,
} from './sheet-workbook';

export {
  type DocumentImportSource,
  isSheetChangeSet,
  isSheetWorkbookModel,
  type SheetChangeSet,
  type SheetWorkbookModel,
  sheetChangeSetSchema,
  sheetWorkbookModelSchema,
};

export const DOCUMENT_KINDS = ['doc', 'sheet', 'deck'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
export const MAX_SHEET_ROWS = 10_000;
export const MAX_SHEET_COLUMNS = 500;
export const MAX_SHEET_CELLS = 50_000;

const sourceRefSchema = z.object({
  kind: z.string().min(1).max(80),
  id: z.string().min(1).max(500),
  label: z.string().max(500).optional(),
  accountId: z.string().max(500).optional(),
  url: z.string().max(2_000).optional(),
});

/**
 * Optional inline formatting for a doc block. `text` stays the canonical
 * plain-text value that native clients and tools read; `runs`, when present,
 * must concatenate to exactly that text. Plain blocks omit `runs`.
 */
const docRunSchema = z.object({
  text: z.string().min(1).max(100_000),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  strike: z.boolean().optional(),
  code: z.boolean().optional(),
});

const docBlockSchema = z
  .object({
    id: z.string().min(1).max(120),
    type: z.enum(['paragraph', 'heading', 'bullet', 'numbered', 'quote']),
    text: z.string().max(100_000),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    runs: z.array(docRunSchema).min(1).max(10_000).optional(),
  })
  .refine(
    (block) => {
      if (!block.runs) return true;
      let length = 0;
      for (const run of block.runs) length += run.text.length;
      return length === block.text.length && block.runs.map((run) => run.text).join('') === block.text;
    },
    { message: 'Block runs must concatenate to exactly the block text.', path: ['runs'] },
  );

const sheetCellSchema = z.object({
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  formula: z.string().max(10_000).optional(),
  format: z.enum(['text', 'number', 'currency', 'percent', 'date']).optional(),
});

const sheetTabSchema = z.object({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(120),
  rowCount: z.number().int().min(1).max(MAX_SHEET_ROWS),
  columnCount: z.number().int().min(1).max(MAX_SHEET_COLUMNS),
  cells: z
    .record(z.string().max(16), sheetCellSchema)
    .refine((cells) => Object.keys(cells).length <= MAX_SHEET_CELLS, {
      message: `A sheet cannot hold more than ${MAX_SHEET_CELLS} cells.`,
    }),
});

const deckElementSchema = z.object({
  id: z.string().min(1).max(120),
  type: z.enum(['text', 'shape']),
  x: z.number().min(0).max(100),
  y: z.number().min(0).max(100),
  width: z.number().min(1).max(100),
  height: z.number().min(1).max(100),
  text: z.string().max(50_000).optional(),
  role: z.enum(['title', 'subtitle', 'body', 'caption', 'shape']).optional(),
  fill: z.string().max(80).optional(),
  color: z.string().max(80).optional(),
  fontSize: z.number().min(8).max(160).optional(),
});

const deckSlideSchema = z.object({
  id: z.string().min(1).max(120),
  title: z.string().max(500),
  notes: z.string().max(50_000).optional(),
  background: z.string().max(80).optional(),
  elements: z.array(deckElementSchema).max(300),
});

export const docModelSchema = z.object({
  kind: z.literal('doc'),
  version: z.literal(1),
  blocks: z.array(docBlockSchema).max(5_000),
});

export const sheetModelSchema = z.object({
  kind: z.literal('sheet'),
  version: z.literal(1),
  activeSheetId: z.string().min(1).max(120),
  sheets: z.array(sheetTabSchema).min(1).max(100),
});

export const deckModelSchema = z.object({
  kind: z.literal('deck'),
  version: z.literal(1),
  activeSlideId: z.string().min(1).max(120),
  slides: z.array(deckSlideSchema).min(1).max(500),
});

// Two `sheet` variants share a discriminator, so this is a plain union; zod
// tries each member in order and the version literal disambiguates them.
export const documentModelSchema = z.union([
  docModelSchema,
  sheetModelSchema,
  sheetWorkbookModelSchema,
  deckModelSchema,
]);

/** What an AI suggestion may carry: a full model, or a change set for engine sheets. */
export const suggestionPayloadSchema = z.union([documentModelSchema, sheetChangeSetSchema]);

export type DocumentSourceRef = z.infer<typeof sourceRefSchema>;
export type DocRun = z.infer<typeof docRunSchema>;
export type DocBlock = z.infer<typeof docBlockSchema>;
export type SheetCell = z.infer<typeof sheetCellSchema>;
export type SheetTab = z.infer<typeof sheetTabSchema>;
export type SheetGridModel = z.infer<typeof sheetModelSchema>;
export type DeckElement = z.infer<typeof deckElementSchema>;
export type DeckSlide = z.infer<typeof deckSlideSchema>;
export type AlbatrossDocumentModel = z.infer<typeof documentModelSchema>;
export type SuggestionPayload = z.infer<typeof suggestionPayloadSchema>;

export interface GoogleDocumentLink {
  connectionId: string;
  fileId: string;
  mimeType: string;
  webUrl?: string;
  providerVersion?: string;
  syncedRevision: number;
  lastSyncedAt: number;
}

export interface AlbatrossDocumentRecord {
  documentId: string;
  kind: DocumentKind;
  title: string;
  model: AlbatrossDocumentModel;
  currentRevision: number;
  sourceRefs: DocumentSourceRef[];
  google?: GoogleDocumentLink;
  importSource?: DocumentImportSource;
  createdAt: number;
  updatedAt: number;
}

export interface DocumentSuggestion {
  baseRevision?: number;
  suggestionId: string;
  documentId: string;
  title: string;
  description: string;
  proposedModel: SuggestionPayload;
  sourceRefs: DocumentSourceRef[];
  status: 'proposed' | 'applied' | 'dismissed';
  createdAt: number;
  resolvedAt?: number;
}

export function createDefaultDocumentModel(kind: DocumentKind, id = crypto.randomUUID()) {
  if (kind === 'doc') {
    return {
      kind: 'doc',
      version: 1,
      blocks: [{ id: `${id}-paragraph-1`, type: 'paragraph', text: '' }],
    } satisfies AlbatrossDocumentModel;
  }
  if (kind === 'sheet') {
    const sheetId = `${id}-sheet-1`;
    return {
      kind: 'sheet',
      version: 1,
      activeSheetId: sheetId,
      sheets: [{ id: sheetId, name: 'Sheet 1', rowCount: 100, columnCount: 26, cells: {} }],
    } satisfies AlbatrossDocumentModel;
  }
  const slideId = `${id}-slide-1`;
  return {
    kind: 'deck',
    version: 1,
    activeSlideId: slideId,
    slides: [
      {
        id: slideId,
        title: 'Title slide',
        elements: [
          {
            id: `${slideId}-title`,
            type: 'text',
            role: 'title',
            x: 10,
            y: 24,
            width: 80,
            height: 18,
            text: '',
            fontSize: 38,
          },
          {
            id: `${slideId}-subtitle`,
            type: 'text',
            role: 'subtitle',
            x: 15,
            y: 50,
            width: 70,
            height: 12,
            text: '',
            fontSize: 20,
          },
        ],
      },
    ],
  } satisfies AlbatrossDocumentModel;
}

export function parseDocumentModel(value: unknown, expectedKind?: DocumentKind): AlbatrossDocumentModel {
  const model = documentModelSchema.parse(value);
  if (expectedKind && model.kind !== expectedKind) {
    throw new Error(`Expected a ${expectedKind} model, received ${model.kind}.`);
  }
  return model;
}

export function parseSuggestionPayload(value: unknown, expectedKind: DocumentKind): SuggestionPayload {
  const payload = suggestionPayloadSchema.parse(value);
  if (payload.kind === 'sheet-changes') {
    if (expectedKind !== 'sheet')
      throw new Error(`Expected a ${expectedKind} model, received sheet changes.`);
    return payload;
  }
  if (payload.kind !== expectedKind) {
    throw new Error(`Expected a ${expectedKind} model, received ${payload.kind}.`);
  }
  return payload;
}

/**
 * Version 1 grid view of any sheet model. Engine workbooks are projected
 * lossily (values and formulas only); use only where a grid is the contract.
 */
export function sheetGridModel(model: AlbatrossDocumentModel): SheetGridModel | null {
  if (model.kind !== 'sheet') return null;
  if (model.version === 1) return model;
  return projectWorkbookToSheetV1(model, {
    maxRows: MAX_SHEET_ROWS,
    maxColumns: MAX_SHEET_COLUMNS,
    maxCells: MAX_SHEET_CELLS,
  });
}

export function documentModelText(model: AlbatrossDocumentModel): string {
  if (model.kind === 'doc') return model.blocks.map((block) => block.text).join('\n');
  if (model.kind === 'sheet') {
    if (model.version === 2) return workbookText(model);
    return model.sheets
      .flatMap((sheet) => [
        sheet.name,
        ...Object.entries(sheet.cells)
          .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
          .map(([address, cell]) => `${address}: ${cell.formula ?? cell.value ?? ''}`),
      ])
      .join('\n');
  }
  return model.slides
    .flatMap((slide, index) => [
      `Slide ${index + 1}: ${slide.title}`,
      ...slide.elements.map((element) => element.text || '').filter(Boolean),
      slide.notes || '',
    ])
    .filter(Boolean)
    .join('\n');
}

export function documentKindLabel(kind: DocumentKind) {
  if (kind === 'doc') return 'Document';
  if (kind === 'sheet') return 'Spreadsheet';
  return 'Presentation';
}

export function documentFileExtension(kind: DocumentKind) {
  if (kind === 'doc') return 'docx';
  if (kind === 'sheet') return 'xlsx';
  return 'pptx';
}
