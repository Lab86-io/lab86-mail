import { truncateText } from '../shared/text';
import { type DeckSlideV2, type DeckTheme, deckModelV2Schema } from './model';

export type PreviewPage =
  | { kind: 'doc'; id: string; blocks: Array<{ id: string; text: string; heading: boolean }> }
  | { kind: 'deck-v2'; id: string; slide: DeckSlideV2; theme: DeckTheme }
  | {
      kind: 'deck';
      id: string;
      background?: string;
      elements: Array<{
        id: string;
        text: string;
        x: number;
        y: number;
        width: number;
        height: number;
        fontSize: number;
        color?: string;
        fill?: string;
      }>;
    }
  | {
      kind: 'sheet';
      id: string;
      name: string;
      rows: Array<{ id: string; cells: Array<{ address: string; text: string }> }>;
    };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function records(value: unknown) {
  return Array.isArray(value) ? value.map(record) : [];
}

function text(value: unknown, limit = 400) {
  return ['string', 'number', 'boolean'].includes(typeof value) ? truncateText(String(value), limit) : '';
}

function bounded(value: unknown, fallback: number, maximum = 100) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(maximum, value))
    : fallback;
}

function color(value: unknown) {
  return typeof value === 'string' && /^#[\da-f]{3,8}$/i.test(value) ? value : undefined;
}

export function documentPreviewPages(value: unknown): PreviewPage[] {
  const model = record(value);
  if (model.kind === 'doc') {
    const blocks = records(model.blocks).slice(0, 24);
    return Array.from({ length: Math.ceil(blocks.length / 8) }, (_, index) => ({
      kind: 'doc',
      id: `page-${index}`,
      blocks: blocks.slice(index * 8, index * 8 + 8).map((block, blockIndex) => ({
        id: text(block.id) || `block-${blockIndex}`,
        text: text(block.text),
        heading: block.type === 'heading',
      })),
    }));
  }
  if (model.kind === 'deck') {
    if (model.version === 2) {
      const parsed = deckModelV2Schema.safeParse({ ...model, slides: records(model.slides).slice(0, 3) });
      if (!parsed.success) return [];
      return parsed.data.slides.map((slide) => ({
        kind: 'deck-v2',
        id: slide.id,
        slide,
        theme: parsed.data.theme,
      }));
    }
    return records(model.slides)
      .slice(0, 3)
      .map((slide, slideIndex) => ({
        kind: 'deck',
        id: text(slide.id) || `slide-${slideIndex}`,
        background: color(slide.background),
        elements: records(slide.elements)
          .slice(0, 40)
          .map((element, elementIndex) => ({
            id: text(element.id) || `element-${elementIndex}`,
            text: text(element.text),
            x: bounded(element.x, 0),
            y: bounded(element.y, 0),
            width: bounded(element.width, 100),
            height: bounded(element.height, 100),
            fontSize: bounded(element.fontSize, 24, 160),
            color: color(element.color),
            fill: color(element.fill),
          })),
      }));
  }
  if (model.kind === 'sheet') {
    const sheets = model.version === 2 ? record(model.workbook).sheets : model.sheets;
    return records(sheets)
      .slice(0, 3)
      .map((sheet, sheetIndex) => {
        const cells = record(sheet.cells);
        return {
          kind: 'sheet',
          id: text(sheet.id) || `sheet-${sheetIndex}`,
          name: text(sheet.name, 80),
          rows: Array.from({ length: 6 }, (_, row) => ({
            id: String(row + 1),
            cells: ['A', 'B', 'C', 'D'].map((column) => {
              const address = `${column}${row + 1}`;
              const cell = cells[address];
              return {
                address,
                text: text(model.version === 2 ? cell : (record(cell).value ?? record(cell).formula), 60),
              };
            }),
          })),
        };
      });
  }
  return [];
}

export function previewDocumentId(path?: string, documentId?: string) {
  if (!path) return documentId;
  if (!path.startsWith('/?')) return undefined;
  const params = new URLSearchParams(path.slice(2));
  if (params.has('office') || params.has('provider')) return undefined;
  return params.get('document') || documentId;
}
