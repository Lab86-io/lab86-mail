import { z } from 'zod';
import {
  type AlbatrossDocumentModel,
  deckModelSchema,
  docModelSchema,
  parseDocumentModel,
  type SuggestionPayload,
} from './model';
import { assertModelWithinLimit, parseCellAddress, sheetChangeSchema } from './sheet-workbook';
import { spreadsheetCommandSchema, validateSpreadsheetCommand } from './spreadsheet-commands';

const id = z.string().min(1).max(200);
const block = docModelSchema.shape.blocks.element;
const blockPatch = z.object(block.shape).omit({ id: true }).partial().strict();
const slide = deckModelSchema.shape.slides.element;
const element = slide.shape.elements.element;
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
  z.object({ op: z.literal('slide_insert'), slide, ...position }).strict(),
  z
    .object({
      op: z.literal('slide_update'),
      slideId: id,
      patch: slide.pick({ title: true, notes: true, background: true }).partial(),
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

/** All operations validate on a private copy before any persistence happens. */
export function prepareDocumentEdits(source: AlbatrossDocumentModel, input: unknown): SuggestionPayload {
  const operations = documentEditsSchema.parse(input);
  const model = structuredClone(parseDocumentModel(source));
  validateIdentity(model);
  if (
    model.kind === 'sheet' &&
    (model.version === 2 || operations.some((operation) => operation.op === 'spreadsheet_command'))
  ) {
    const sheets = model.version === 2 ? model.workbook.sheets : model.sheets;
    const onlyCells = operations.every((operation) => operation.op === 'cell_update');
    const commands = operations.map((operation) => {
      if (operation.op === 'spreadsheet_command') return validateSpreadsheetCommand(operation.command);
      if (operation.op !== 'cell_update') throw new Error('This operation does not target a spreadsheet.');
      const sheet = sheets[indexOf(sheets, operation.sheetId)];
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
  const validated = parseDocumentModel(model);
  assertModelWithinLimit(validated);
  return validated;
}
