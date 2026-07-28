import { z } from 'zod';

export const DOCUMENT_KINDS = ['doc', 'sheet', 'deck'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
export const MAX_SHEET_ROWS = 10_000;
export const MAX_SHEET_COLUMNS = 500;

const sourceRefSchema = z.object({
  kind: z.string().min(1).max(80),
  id: z.string().min(1).max(500),
  label: z.string().max(500).optional(),
  accountId: z.string().max(500).optional(),
  url: z.string().max(2_000).optional(),
});

const docBlockSchema = z.object({
  id: z.string().min(1).max(120),
  type: z.enum(['paragraph', 'heading', 'bullet', 'numbered', 'quote']),
  text: z.string().max(100_000),
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
});

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
  cells: z.record(z.string(), sheetCellSchema),
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

export const documentModelSchema = z.discriminatedUnion('kind', [
  docModelSchema,
  sheetModelSchema,
  deckModelSchema,
]);

export type DocumentSourceRef = z.infer<typeof sourceRefSchema>;
export type DocBlock = z.infer<typeof docBlockSchema>;
export type SheetCell = z.infer<typeof sheetCellSchema>;
export type SheetTab = z.infer<typeof sheetTabSchema>;
export type DeckElement = z.infer<typeof deckElementSchema>;
export type DeckSlide = z.infer<typeof deckSlideSchema>;
export type AlbatrossDocumentModel = z.infer<typeof documentModelSchema>;

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
  createdAt: number;
  updatedAt: number;
}

export interface DocumentSuggestion {
  suggestionId: string;
  documentId: string;
  title: string;
  description: string;
  proposedModel: AlbatrossDocumentModel;
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

export function documentModelText(model: AlbatrossDocumentModel): string {
  if (model.kind === 'doc') return model.blocks.map((block) => block.text).join('\n');
  if (model.kind === 'sheet') {
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
