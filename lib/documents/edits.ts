import { z } from 'zod';
import { deckModelForSave, upgradeDeckModel } from './deck-versions';
import {
  type AlbatrossDocumentModel,
  type DeckTheme,
  deckElementV2Schema,
  deckSlideV2Schema,
  docModelSchema,
  parseDocumentModel,
  type SuggestionPayload,
} from './model';
import { type CompositionArtwork, FONT_PAIR_NAMES, PALETTE_NAMES } from './presentation-compositions';
import { deckPaletteColorsSchema, restyleDeck } from './presentation-design';
import { assertModelWithinLimit, parseCellAddress, sheetChangeSchema } from './sheet-workbook';
import { spreadsheetCommandSchema, validateSpreadsheetCommand } from './spreadsheet-commands';

const id = z.string().min(1).max(200);
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const block = docModelSchema.shape.blocks.element;
const blockPatch = z.object(block.shape).omit({ id: true }).partial().strict();
const slide = deckSlideV2Schema
  .strict()
  .describe(
    'Rendered slide: visible content belongs in elements. title and notes are metadata. Presentation brief fields such as body, items, kicker and chart are not accepted here.',
  );
const element = deckElementV2Schema;
function assertFitsCanvas(item: z.infer<typeof element>) {
  if (item.x + item.width > 100 || item.y + item.height > 100)
    throw new Error('The element must fit inside the slide canvas.');
}
const position = { afterId: id.nullable().describe('Existing sibling ID, or null to place first.') };

/** Narrow, deterministic edits: the agent need not regenerate an entire file. */
export const documentEditOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('spreadsheet_command'), command: spreadsheetCommandSchema }).strict(),
  z.object({ op: z.literal('block_insert'), block, ...position }).strict(),
  z.object({ op: z.literal('block_update'), blockId: id, patch: blockPatch }).strict(),
  z.object({ op: z.literal('block_remove'), blockId: id }).strict(),
  z.object({ op: z.literal('block_move'), blockId: id, ...position }).strict(),
  z
    .object({
      op: z.literal('deck_restyle'),
      /** Named palette or a custom six-color set. Omit to keep the current colors. */
      palette: z.union([z.enum(PALETTE_NAMES), deckPaletteColorsSchema]).optional(),
      /** serif: Fraunces display with Geist text. sans: Geist throughout. Omit to keep the current fonts. */
      fontPair: z.enum(FONT_PAIR_NAMES).optional(),
      /** theme: colors and fonts only. theme-and-layout: also recompose every slide; facts, charts, notes and order stay. */
      scope: z.enum(['theme', 'theme-and-layout']).default('theme'),
      /** Elements kept exactly as they are, in addition to elements marked locked. */
      lockedElementIds: z.array(id).max(500).optional(),
      /** paintings: hang credited public-domain paintings on slides without an image. none: remove the paintings; the user's images stay. */
      imagery: z.enum(['paintings', 'none']).optional(),
      /** Legacy form: dark or light with one accent. Kept for older callers. */
      theme: z.enum(['dark', 'light']).optional(),
      accent: hexColor.optional(),
    })
    .strict()
    .refine(
      (value) =>
        value.theme || value.palette || value.fontPair || value.imagery || value.scope === 'theme-and-layout',
      {
        message: 'deck_restyle needs a palette, a fontPair, imagery, a layout scope, or the legacy theme.',
      },
    ),
  z.object({ op: z.literal('slide_insert'), slide, ...position }).strict(),
  z
    .object({
      op: z.literal('slide_update'),
      slideId: id,
      patch: slide.pick({ title: true, notes: true, background: true }).partial().strict(),
    })
    .strict(),
  z.object({ op: z.literal('slide_remove'), slideId: id }).strict(),
  z.object({ op: z.literal('slide_move'), slideId: id, ...position }).strict(),
  z.object({ op: z.literal('element_upsert'), slideId: id, element }).strict(),
  z.object({ op: z.literal('element_remove'), slideId: id, elementId: id }).strict(),
  z
    .object({
      op: z.literal('cell_update'),
      sheetId: id.describe('Exact sheet ID from document_get; not a guessed sheet name.'),
      cell: sheetChangeSchema.shape.cell,
      content: sheetChangeSchema.shape.content,
    })
    .strict(),
]);
export const documentEditsSchema = z.array(documentEditOperationSchema).min(1).max(500);
export type DocumentEditOperation = z.infer<typeof documentEditOperationSchema>;

function indexOf(items: { id: string }[], target: string) {
  const index = items.findIndex((item) => item.id === target);
  if (index < 0) throw new Error(`Unknown item ID: ${target}. Read the current file before editing.`);
  return index;
}

function insert<T extends { id: string }>(items: T[], item: T, afterId: string | null) {
  if (items.some((candidate) => candidate.id === item.id)) throw new Error(`Duplicate item ID: ${item.id}.`);
  items.splice(afterId === null ? 0 : indexOf(items, afterId) + 1, 0, item);
}

function move<T extends { id: string }>(items: T[], target: string, afterId: string | null) {
  const index = indexOf(items, target);
  if (target === afterId) throw new Error('An item cannot be moved after itself.');
  if (afterId !== null) indexOf(items, afterId);
  const [item] = items.splice(index, 1);
  insert(items, item, afterId);
}

function validateIdentity(model: AlbatrossDocumentModel) {
  const unique = (items: { id: string }[]) => {
    if (new Set(items.map((item) => item.id)).size !== items.length)
      throw new Error('The file contains ambiguous duplicate IDs. Repair them before applying edits.');
  };
  if (model.kind === 'doc') unique(model.blocks);
  else if (model.kind === 'deck') {
    unique(model.slides);
    for (const item of model.slides) unique(item.elements);
  } else unique(model.version === 2 ? model.workbook.sheets : model.sheets);
}

/** Resources an edit may need that the operation itself cannot carry. */
export interface DocumentEditContext {
  /** Credited paintings by slide id for a deck_restyle with imagery paintings, resolved by the caller. */
  artworks?: Partial<Record<string, CompositionArtwork>>;
  /** The deck-wide imagery record that goes with those paintings. */
  imageryTheme?: NonNullable<DeckTheme['imagery']>;
}

/** All operations validate on a private copy before any persistence happens. */
export function prepareDocumentEdits(
  source: AlbatrossDocumentModel,
  input: unknown,
  context: DocumentEditContext = {},
): SuggestionPayload {
  const operations = documentEditsSchema.parse(input);
  const parsed = parseDocumentModel(source);
  // Slide edits run on version 2; a deck stored as version 1 keeps that shape when it can.
  const model = structuredClone(parsed.kind === 'deck' ? upgradeDeckModel(parsed) : parsed);
  validateIdentity(model);
  if (
    model.kind === 'sheet' &&
    (model.version === 2 || operations.some((operation) => operation.op === 'spreadsheet_command'))
  ) {
    const sheets = model.version === 2 ? model.workbook.sheets : model.sheets;
    const createdSheetIds = new Set<string>();
    const onlyCells = operations.every((operation) => operation.op === 'cell_update');
    const commands = operations.map((operation) => {
      if (operation.op === 'spreadsheet_command') {
        const command = validateSpreadsheetCommand(operation.command);
        if (command.type === 'CREATE_SHEET') createdSheetIds.add(String(command.payload.sheetId));
        return command;
      }
      if (operation.op !== 'cell_update') throw new Error('This operation does not target a spreadsheet.');
      const sheet = createdSheetIds.has(operation.sheetId)
        ? { id: operation.sheetId, rowCount: 0, columnCount: 0 }
        : sheets[indexOf(sheets, operation.sheetId)];
      const address = parseCellAddress(operation.cell)!;
      if (
        onlyCells &&
        (address.row > Number('rowNumber' in sheet ? sheet.rowNumber : sheet.rowCount) ||
          address.column > Number('colNumber' in sheet ? sheet.colNumber : sheet.columnCount))
      )
        throw new Error(
          `Cell ${operation.cell} is outside this sheet. Add a resize command before editing it.`,
        );
      return {
        type: 'UPDATE_CELL',
        payload: {
          sheetId: sheet.id,
          col: address.column - 1,
          row: address.row - 1,
          content: operation.content,
        },
      };
    });
    // Preserve command order: later operations may target newly created sheets,
    // expanded ranges, charts, or styles from earlier commands in the same batch.
    const proposal = onlyCells
      ? {
          kind: 'sheet-changes' as const,
          version: 1 as const,
          changes: operations.map((operation) => ({
            sheet: operation.sheetId,
            cell: operation.cell,
            content: operation.content,
          })),
        }
      : { kind: 'sheet-changes' as const, version: 1 as const, changes: [], commands };
    assertModelWithinLimit(proposal);
    return proposal;
  }
  for (const operation of operations) {
    if (operation.op.startsWith('block_')) {
      if (model.kind !== 'doc') throw new Error('Block edits require a text document.');
      switch (operation.op) {
        case 'block_insert':
          insert(model.blocks, operation.block, operation.afterId);
          break;
        case 'block_update': {
          const index = indexOf(model.blocks, operation.blockId);
          const current = model.blocks[index];
          // Text is the native-compatible projection. A text replacement must
          // not keep inline runs describing the old text.
          const next = { ...current, ...operation.patch };
          if (
            operation.patch.text !== undefined &&
            operation.patch.text !== current.text &&
            !('runs' in operation.patch)
          )
            delete (next as typeof next & { runs?: unknown }).runs;
          model.blocks[index] = next;
          break;
        }
        case 'block_remove':
          model.blocks.splice(indexOf(model.blocks, operation.blockId), 1);
          break;
        case 'block_move':
          move(model.blocks, operation.blockId, operation.afterId);
          break;
      }
    } else if (operation.op === 'cell_update') {
      if (model.kind !== 'sheet') throw new Error('Cell edits require a spreadsheet.');
      const sheet = model.sheets[indexOf(model.sheets, operation.sheetId)];
      const address = parseCellAddress(operation.cell)!;
      if (address.row > sheet.rowCount || address.column > sheet.columnCount)
        throw new Error(`Cell ${operation.cell} is outside this sheet. Resize it in the editor first.`);
      const previous = sheet.cells[operation.cell];
      sheet.cells[operation.cell] = operation.content.startsWith('=')
        ? { format: previous?.format, formula: operation.content.slice(1) }
        : { format: previous?.format, value: operation.content };
    } else {
      if (model.kind !== 'deck') throw new Error('Slide and element edits require a presentation.');
      switch (operation.op) {
        case 'deck_restyle': {
          if (operation.theme) {
            // Legacy form: theme every slide without inventing geometry or replacing its content.
            const accent = operation.accent ?? '#7c83ff';
            const ink = operation.theme === 'dark' ? '#f3f4f6' : '#111827';
            model.theme = {
              ...model.theme,
              colors: {
                ...model.theme.colors,
                background: operation.theme === 'dark' ? '#111827' : '#ffffff',
                ink,
                accent,
              },
            };
            for (const target of model.slides) {
              target.background = operation.theme === 'dark' ? '#111827' : '#ffffff';
              for (const item of target.elements) {
                if (item.type === 'shape') {
                  item.fill = accent;
                  continue;
                }
                if (item.type !== 'text') continue;
                item.color = item.role === 'title' ? accent : ink;
                item.fontSize ??= item.role === 'title' ? 28 : 16;
              }
            }
            break;
          }
          // Palette, fonts and optionally layout change; facts, charts, notes, order and locked elements stay.
          const restyled = restyleDeck(model, {
            ...(operation.palette ? { palette: operation.palette } : {}),
            ...(operation.fontPair ? { fontPair: operation.fontPair } : {}),
            scope: operation.scope,
            ...(operation.lockedElementIds ? { lockedElementIds: operation.lockedElementIds } : {}),
            ...(operation.imagery ? { imagery: operation.imagery } : {}),
            ...(context.artworks ? { artworks: context.artworks } : {}),
            ...(context.imageryTheme ? { imageryTheme: context.imageryTheme } : {}),
          });
          model.theme = restyled.theme;
          model.slides = restyled.slides;
          break;
        }
        case 'slide_insert':
          operation.slide.elements.forEach(assertFitsCanvas);
          insert(model.slides, operation.slide, operation.afterId);
          break;
        case 'slide_update': {
          const index = indexOf(model.slides, operation.slideId);
          model.slides[index] = { ...model.slides[index], ...operation.patch };
          break;
        }
        case 'slide_remove':
          if (model.slides.length === 1) throw new Error('A presentation must retain at least one slide.');
          model.slides.splice(indexOf(model.slides, operation.slideId), 1);
          if (model.activeSlideId === operation.slideId) model.activeSlideId = model.slides[0].id;
          break;
        case 'slide_move':
          move(model.slides, operation.slideId, operation.afterId);
          break;
        case 'element_upsert': {
          assertFitsCanvas(operation.element);
          const target = model.slides[indexOf(model.slides, operation.slideId)];
          const index = target.elements.findIndex((item) => item.id === operation.element.id);
          if (index < 0) target.elements.push(operation.element);
          else target.elements[index] = operation.element;
          break;
        }
        case 'element_remove': {
          const target = model.slides[indexOf(model.slides, operation.slideId)];
          target.elements.splice(indexOf(target.elements, operation.elementId), 1);
          break;
        }
      }
    }
  }
  validateIdentity(model);
  const validated = parseDocumentModel(
    model.kind === 'deck' && parsed.kind === 'deck' ? deckModelForSave(model, parsed.version) : model,
  );
  assertModelWithinLimit(validated);
  return validated;
}
