import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import ExcelJS from 'exceljs';
import pptxgen from 'pptxgenjs';
import { truncateText } from '../shared/text';
import { loadDeckAsset } from './deck-assets';
import { deckExportFace, deckTextSlot, upgradeDeckModel } from './deck-versions';
import { type AlbatrossDocumentRecord, type DeckElementV2, type DocBlock, sheetGridModel } from './model';

export interface DocumentExport {
  bytes: Uint8Array;
  contentType: string;
  extension: 'docx' | 'xlsx' | 'pptx';
  /**
   * `projection` means the bytes were rebuilt from values and formulas only.
   * Engine-backed sheets get their full-fidelity .xlsx from the editor itself.
   */
  fidelity: 'full' | 'projection';
}

/** Export the canonical text even if an older client submitted stale styling. */
function textRunsForBlock(block: DocBlock) {
  const runs: NonNullable<DocBlock['runs']> =
    block.runs && block.runs.map((run) => run.text).join('') === block.text
      ? block.runs
      : [{ text: block.text }];
  return runs.flatMap((run) =>
    run.text.split('\n').map(
      (text, index) =>
        new TextRun({
          text,
          break: index ? 1 : undefined,
          bold: run.bold,
          italics: run.italic || block.type === 'quote',
          underline: run.underline ? { type: 'single' } : undefined,
          strike: run.strike,
          font: run.code ? 'Consolas' : undefined,
          color: block.type === 'quote' ? '52606D' : undefined,
        }),
    ),
  );
}

function paragraphForBlock(block: DocBlock, numberingReference = 'ordered') {
  const children = textRunsForBlock(block);
  if (block.type === 'heading') {
    const heading =
      block.level === 1
        ? HeadingLevel.HEADING_1
        : block.level === 3
          ? HeadingLevel.HEADING_3
          : HeadingLevel.HEADING_2;
    return new Paragraph({ children, heading });
  }
  if (block.type === 'bullet') {
    return new Paragraph({ children, bullet: { level: 0 } });
  }
  if (block.type === 'numbered') {
    return new Paragraph({
      children,
      numbering: { reference: numberingReference, level: 0 },
    });
  }
  if (block.type === 'quote') {
    return new Paragraph({
      children,
      indent: { left: 500 },
    });
  }
  return new Paragraph({ children });
}

async function exportDoc(document: AlbatrossDocumentRecord): Promise<DocumentExport> {
  if (document.model.kind !== 'doc') throw new Error('Document model mismatch.');
  let listGroup = 0;
  const references = document.model.blocks.map((block, index, blocks) => {
    if (block.type === 'numbered' && blocks[index - 1]?.type !== 'numbered') listGroup += 1;
    return `ordered-${listGroup}`;
  });
  const file = new Document({
    title: document.title,
    numbering: {
      config: Array.from({ length: listGroup }, (_, index) => ({
        reference: `ordered-${index + 1}`,
        levels: [{ level: 0, format: 'decimal' as const, text: '%1.', alignment: 'left' as const }],
      })),
    },
    sections: [
      {
        children: document.model.blocks.map((block, index) => paragraphForBlock(block, references[index])),
      },
    ],
  });
  return {
    bytes: await Packer.toBuffer(file),
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: 'docx',
    fidelity: 'full',
  };
}

function columnIndex(address: string) {
  const match = /^([A-Z]+)(\d+)$/iu.exec(address);
  if (!match) return null;
  let column = 0;
  for (const character of match[1].toUpperCase()) {
    column = column * 26 + character.charCodeAt(0) - 64;
  }
  return { row: Number(match[2]), column };
}

export function presentationColor(value: string | undefined, fallback: string) {
  const normalized = String(value || '')
    .trim()
    .replace(/^#/u, '')
    .toUpperCase();
  return /^[0-9A-F]{6}$/u.test(normalized) ? normalized : fallback;
}

export function uniqueWorksheetName(name: string, used: Set<string>) {
  const cleaned =
    name
      .replace(/[*?:/\\[\]]/gu, '')
      .trim()
      .replace(/^'+|'+$/gu, '')
      .trim() || 'Sheet';
  const base = truncateText(cleaned, 31) || 'Sheet';
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate.toLocaleLowerCase('en-US'))) {
    const marker = ` (${suffix})`;
    candidate = `${truncateText(base, 31 - marker.length)}${marker}`;
    suffix += 1;
  }
  used.add(candidate.toLocaleLowerCase('en-US'));
  return candidate;
}

async function exportSheet(document: AlbatrossDocumentRecord): Promise<DocumentExport> {
  const grid = sheetGridModel(document.model);
  if (!grid) throw new Error('Spreadsheet model mismatch.');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Albatross';
  workbook.created = new Date(document.createdAt);
  const worksheetNames = new Set<string>();
  for (const tab of grid.sheets) {
    const worksheet = workbook.addWorksheet(uniqueWorksheetName(tab.name, worksheetNames));
    for (const [address, cell] of Object.entries(tab.cells)) {
      const position = columnIndex(address);
      if (!position) continue;
      if (
        position.row < 1 ||
        position.row > tab.rowCount ||
        position.column < 1 ||
        position.column > tab.columnCount
      ) {
        continue;
      }
      const target = worksheet.getCell(position.row, position.column);
      target.value = cell.formula ? { formula: cell.formula.replace(/^=/u, '') } : (cell.value ?? '');
      if (cell.format === 'currency') target.numFmt = '$#,##0.00';
      if (cell.format === 'percent') target.numFmt = '0.00%';
      if (cell.format === 'date') target.numFmt = 'yyyy-mm-dd';
    }
    worksheet.views = [{ state: 'frozen', ySplit: 1 }];
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return {
    bytes: new Uint8Array(buffer),
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extension: 'xlsx',
    fidelity: document.model.kind === 'sheet' && document.model.version === 2 ? 'projection' : 'full',
  };
}

const SLIDE_WIDTH_IN = 13.333;
const SLIDE_HEIGHT_IN = 7.5;
const DASH: Record<string, 'solid' | 'dash' | 'sysDot'> = { solid: 'solid', dash: 'dash', dot: 'sysDot' };

function inches(element: { x: number; y: number; width: number; height: number }) {
  return {
    x: (element.x / 100) * SLIDE_WIDTH_IN,
    y: (element.y / 100) * SLIDE_HEIGHT_IN,
    w: (element.width / 100) * SLIDE_WIDTH_IN,
    h: (element.height / 100) * SLIDE_HEIGHT_IN,
  };
}

/** Default type size by role; matches the canvas renderer. */
export function deckTextSize(element: Extract<DeckElementV2, { type: 'text' }>) {
  if (element.fontSize) return element.fontSize;
  switch (element.role) {
    case 'title':
      return 28;
    case 'number':
      return 64;
    case 'subtitle':
      return 20;
    case 'caption':
    case 'kicker':
      return 12;
    default:
      return 16;
  }
}

/**
 * Presentation export keeps every element editable in PowerPoint: text stays
 * text, shapes stay shapes, charts are native charts, images are images. No
 * slide is flattened to a picture. Rotation, dashes and roundness map directly;
 * focal-point crops become centered cover crops, the one documented loss.
 */
async function exportDeck(document: AlbatrossDocumentRecord): Promise<DocumentExport> {
  if (document.model.kind !== 'deck') throw new Error('Presentation model mismatch.');
  const model = upgradeDeckModel(document.model);
  const theme = model.theme;
  const presentation = new pptxgen();
  presentation.author = 'Albatross';
  presentation.subject = document.title;
  presentation.title = document.title;
  presentation.layout = 'LAYOUT_WIDE';
  const assets = new Map<string, Promise<string>>();
  const asset = (src: string) => {
    if (!assets.has(src))
      assets.set(
        src,
        loadDeckAsset(src).then((loaded) => loaded.data),
      );
    return assets.get(src)!;
  };
  for (const source of model.slides) {
    const slide = presentation.addSlide();
    slide.background = { color: presentationColor(source.background ?? theme.colors.background, 'FFFFFF') };
    if (source.backgroundImage?.src) {
      slide.addImage({
        data: await asset(source.backgroundImage.src),
        x: 0,
        y: 0,
        w: SLIDE_WIDTH_IN,
        h: SLIDE_HEIGHT_IN,
        sizing: { type: 'cover', w: SLIDE_WIDTH_IN, h: SLIDE_HEIGHT_IN },
        transparency: Math.round((1 - (source.backgroundImage.opacity ?? 1)) * 100),
      });
    }
    for (const element of source.elements) {
      const box = inches(element);
      const common = { ...box, rotate: element.rotation || 0 };
      const transparency =
        element.opacity !== undefined ? Math.round((1 - element.opacity) * 100) : undefined;
      if (element.type === 'text') {
        const size = deckTextSize(element);
        const slot = deckTextSlot(element);
        slide.addText(element.text || '', {
          ...common,
          fontFace: deckExportFace(theme, slot),
          fontSize: size,
          bold:
            (element.fontWeight ?? (element.role === 'title' || element.role === 'number' ? 650 : 400)) >=
            600,
          italic: Boolean(element.italic),
          color: presentationColor(element.color ?? theme.colors.ink, '17202A'),
          align: element.align ?? 'left',
          valign: element.valign ?? 'middle',
          lineSpacingMultiple: element.lineHeight ?? (slot === 'display' ? 1.05 : 1.3),
          charSpacing: element.letterSpacing ? Math.round(element.letterSpacing * size * 10) / 10 : undefined,
          ...(element.fill
            ? { fill: { color: presentationColor(element.fill, 'FFFFFF'), transparency } }
            : {}),
          margin: 0.08,
          breakLine: false,
        });
      } else if (element.type === 'shape') {
        const kind =
          element.shape === 'ellipse'
            ? presentation.ShapeType.ellipse
            : element.shape === 'roundRect'
              ? presentation.ShapeType.roundRect
              : presentation.ShapeType.rect;
        slide.addShape(kind, {
          ...common,
          fill: { color: presentationColor(element.fill ?? theme.colors.surface, 'E8EEF5'), transparency },
          line: element.stroke
            ? {
                color: presentationColor(element.stroke.color, '94A3B8'),
                width: element.stroke.width,
                dashType: DASH[element.stroke.dash ?? 'solid'],
              }
            : { color: presentationColor(element.fill ?? theme.colors.surface, 'E8EEF5'), width: 0 },
          ...(element.shape === 'roundRect' && element.radius ? { rectRadius: element.radius / 72 } : {}),
        });
      } else if (element.type === 'line') {
        slide.addShape(presentation.ShapeType.line, {
          ...common,
          flipV: Boolean(element.flip),
          line: {
            color: presentationColor(element.stroke.color, '17202A'),
            width: element.stroke.width,
            dashType: DASH[element.stroke.dash ?? 'solid'],
          },
        });
      } else if (element.type === 'image') {
        if (!element.src)
          throw new Error(`Image "${element.alt || element.id}" has no owned source to export.`);
        slide.addImage({
          data: await asset(element.src),
          ...common,
          altText: element.alt,
          sizing: { type: element.fit ?? 'cover', w: box.w, h: box.h },
          transparency,
        });
      } else if (element.type === 'chart') {
        const type =
          element.chart === 'line'
            ? presentation.ChartType.line
            : element.chart === 'pie'
              ? presentation.ChartType.pie
              : element.chart === 'doughnut'
                ? presentation.ChartType.doughnut
                : presentation.ChartType.bar;
        const colors = (
          element.colors?.length
            ? element.colors
            : [theme.colors.accent, theme.colors.ink, theme.colors.muted, theme.colors.surface]
        ).map((color) => presentationColor(color, '17202A'));
        const ink = presentationColor(theme.colors.ink, '17202A');
        const muted = presentationColor(theme.colors.muted, '94A3B8');
        const body = deckExportFace(theme, 'body');
        slide.addChart(
          type,
          element.series.map((series) => ({
            name: series.name,
            labels: element.categories,
            values: series.values,
          })),
          {
            ...box,
            barDir: element.chart === 'bar' ? 'bar' : 'col',
            chartColors: colors,
            showLegend: element.legend ?? element.series.length > 1,
            legendPos: 'b',
            legendColor: ink,
            legendFontFace: body,
            showValue: Boolean(element.values),
            dataLabelColor: ink,
            dataLabelFontFace: body,
            dataLabelFontSize: 10,
            catAxisLabelColor: ink,
            catAxisLabelFontFace: body,
            catAxisLabelFontSize: 10,
            valAxisLabelColor: muted,
            valAxisLabelFontFace: body,
            valAxisLabelFontSize: 9,
            valAxisMaxVal:
              Math.ceil((Math.max(1, ...element.series.flatMap((series) => series.values)) * 1.1) / 10) * 10,
            valAxisLabelFormatCode: element.unit ? `0"${element.unit.replace(/"/g, '')}"` : '0',
            dataLabelFormatCode: element.unit ? `0"${element.unit.replace(/"/g, '')}"` : '0',
            valGridLine: { color: muted, style: 'dash', size: 0.5 },
            catGridLine: { style: 'none' },
            catAxisLineShow: false,
            valAxisLineShow: false,
            barGapWidthPct: 60,
            ...(element.chart === 'pie' || element.chart === 'doughnut'
              ? { showPercent: false, showLabel: true, dataLabelPosition: 'bestFit' }
              : {}),
          },
        );
      }
    }
    if (source.notes) slide.addNotes(source.notes);
  }
  const buffer = await presentation.write({ outputType: 'nodebuffer' });
  return {
    bytes: new Uint8Array(buffer as Buffer),
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    extension: 'pptx',
    fidelity: 'full',
  };
}

export async function exportDocument(document: AlbatrossDocumentRecord): Promise<DocumentExport> {
  if (document.kind === 'doc') return exportDoc(document);
  if (document.kind === 'sheet') return exportSheet(document);
  return exportDeck(document);
}
