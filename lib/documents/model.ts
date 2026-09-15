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
  x: z
    .number()
    .min(0)
    .max(100)
    .describe('Left edge as percent of slide width (0–100). x + width must not exceed 100.'),
  y: z
    .number()
    .min(0)
    .max(100)
    .describe('Top edge as percent of slide height (0–100); never negative. y + height must not exceed 100.'),
  width: z
    .number()
    .min(1)
    .max(100)
    .describe('Width as percent of slide width, minimum 1; keep inside canvas.'),
  height: z
    .number()
    .min(1)
    .max(100)
    .describe('Height as percent of slide height, minimum 1 even for accent lines; keep inside canvas.'),
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

/**
 * Deck version 2: a deck-level design system plus typed elements. Version 1
 * decks stay valid and lift losslessly through `upgradeDeckModel` in
 * `components/files/editors/deck-model.ts`; a deck is written as version 2 only
 * when it uses something version 1 cannot hold.
 */
const deckColorSchema = z.string().max(80);
const deckFontSchema = z.object({
  /** Web family rendered on the canvas, e.g. "Fraunces". */
  family: z.string().min(1).max(80),
  /** PPTX face when the web family is not Office-safe, e.g. "Georgia". */
  exportFamily: z.string().min(1).max(80).optional(),
  fallback: z.enum(['serif', 'sans-serif', 'monospace']).optional(),
});
export const deckThemeSchema = z.object({
  name: z.string().max(80).optional(),
  colors: z.object({
    background: deckColorSchema,
    surface: deckColorSchema,
    ink: deckColorSchema,
    muted: deckColorSchema,
    accent: deckColorSchema,
    accentInk: deckColorSchema,
  }),
  fonts: z.object({
    display: deckFontSchema,
    body: deckFontSchema,
    mono: deckFontSchema.optional(),
  }),
});

const deckElementBase = {
  id: z.string().min(1).max(120),
  x: z.number().min(0).max(100),
  y: z.number().min(0).max(100),
  width: z.number().min(1).max(100),
  height: z.number().min(1).max(100),
  rotation: z.number().min(-360).max(360).optional(),
  opacity: z.number().min(0).max(1).optional(),
  locked: z.boolean().optional(),
  groupId: z.string().max(120).optional(),
  name: z.string().max(120).optional(),
  /** Deliberate design overlap; the quality check does not flag this element. */
  overlapAllowed: z.boolean().optional(),
};
const deckStrokeSchema = z.object({
  color: deckColorSchema,
  /** Points, as in PowerPoint. */
  width: z.number().min(0.25).max(24),
  dash: z.enum(['solid', 'dash', 'dot']).optional(),
});
const deckTextElementSchema = z.object({
  ...deckElementBase,
  type: z.literal('text'),
  text: z.string().max(50_000),
  role: z.enum(['title', 'subtitle', 'body', 'caption', 'kicker', 'number']).optional(),
  /** Theme font slot. Defaults follow the role: title/number use display. */
  font: z.enum(['display', 'body', 'mono']).optional(),
  fontSize: z.number().min(8).max(240).optional(),
  fontWeight: z.number().int().min(100).max(900).optional(),
  italic: z.boolean().optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
  valign: z.enum(['top', 'middle', 'bottom']).optional(),
  lineHeight: z.number().min(0.8).max(3).optional(),
  /** Em units. */
  letterSpacing: z.number().min(-0.1).max(0.5).optional(),
  color: deckColorSchema.optional(),
  fill: deckColorSchema.optional(),
});
const deckShapeElementSchema = z.object({
  ...deckElementBase,
  type: z.literal('shape'),
  shape: z.enum(['rect', 'roundRect', 'ellipse']).optional(),
  fill: deckColorSchema.optional(),
  stroke: deckStrokeSchema.optional(),
  /** Corner radius in points for roundRect. */
  radius: z.number().min(0).max(120).optional(),
});
const deckLineElementSchema = z.object({
  ...deckElementBase,
  type: z.literal('line'),
  /** Lines may be flat; their box can have zero width or height. */
  width: z.number().min(0).max(100),
  height: z.number().min(0).max(100),
  /** false: top-left to bottom-right. true: bottom-left to top-right. */
  flip: z.boolean().optional(),
  stroke: deckStrokeSchema,
});
const deckImageElementSchema = z.object({
  ...deckElementBase,
  type: z.literal('image'),
  /** Owned asset reference; never a temporary external link. */
  assetId: z.string().min(1).max(200),
  /** Resolved, owned URL for rendering; may be re-derived from assetId. */
  src: z.string().max(2_000).optional(),
  alt: z.string().max(1_000),
  fit: z.enum(['cover', 'contain']).optional(),
  focal: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).optional(),
  /** Intrinsic width / height, when known. */
  aspect: z.number().min(0.05).max(20).optional(),
  radius: z.number().min(0).max(120).optional(),
  source: z.string().max(500).optional(),
  /** A backdrop image; content may sit on top of it. */
  decorative: z.boolean().optional(),
});
const deckChartElementSchema = z.object({
  ...deckElementBase,
  type: z.literal('chart'),
  chart: z.enum(['bar', 'column', 'line', 'pie', 'doughnut']),
  categories: z.array(z.string().max(120)).min(1).max(60),
  series: z
    .array(z.object({ name: z.string().max(120), values: z.array(z.number()).min(1).max(60) }))
    .min(1)
    .max(12),
  colors: z.array(deckColorSchema).max(12).optional(),
  legend: z.boolean().optional(),
  values: z.boolean().optional(),
  unit: z.string().max(20).optional(),
  source: z.string().max(500).optional(),
});
export const deckElementV2Schema = z.discriminatedUnion('type', [
  deckTextElementSchema,
  deckShapeElementSchema,
  deckLineElementSchema,
  deckImageElementSchema,
  deckChartElementSchema,
]);
export const deckSlideV2Schema = z.object({
  id: z.string().min(1).max(120),
  title: z.string().max(500),
  notes: z.string().max(50_000).optional(),
  background: deckColorSchema.optional(),
  backgroundImage: z
    .object({
      assetId: z.string().min(1).max(200),
      src: z.string().max(2_000).optional(),
      opacity: z.number().min(0).max(1).optional(),
      focal: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).optional(),
    })
    .optional(),
  elements: z.array(deckElementV2Schema).max(300),
});
export const deckModelV2Schema = z.object({
  kind: z.literal('deck'),
  version: z.literal(2),
  activeSlideId: z.string().min(1).max(120),
  theme: deckThemeSchema,
  slides: z.array(deckSlideV2Schema).min(1).max(500),
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
  deckModelV2Schema,
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
export type DeckTheme = z.infer<typeof deckThemeSchema>;
export type DeckElementV2 = z.infer<typeof deckElementV2Schema>;
export type DeckTextElement = z.infer<typeof deckTextElementSchema>;
export type DeckShapeElement = z.infer<typeof deckShapeElementSchema>;
export type DeckLineElement = z.infer<typeof deckLineElementSchema>;
export type DeckImageElement = z.infer<typeof deckImageElementSchema>;
export type DeckChartElement = z.infer<typeof deckChartElementSchema>;
export type DeckSlideV2 = z.infer<typeof deckSlideV2Schema>;
export type DeckModelV2 = z.infer<typeof deckModelV2Schema>;
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
      ...slide.elements.map((element) => deckElementText(element)).filter(Boolean),
      slide.notes || '',
    ])
    .filter(Boolean)
    .join('\n');
}

/** Readable text of one slide element of either deck version, for search and AI context. */
export function deckElementText(element: DeckElement | DeckElementV2): string {
  if (element.type === 'text') return element.text || '';
  if (element.type === 'image') return element.alt || '';
  if (element.type === 'chart')
    return element.series
      .map(
        (series) =>
          `${series.name}: ${element.categories.map((c, i) => `${c} ${series.values[i] ?? ''}`).join(', ')}`,
      )
      .join('\n');
  return '';
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
