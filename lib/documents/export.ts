import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import ExcelJS from 'exceljs';
import pptxgen from 'pptxgenjs';
import { type AlbatrossDocumentRecord, type DocBlock, sheetGridModel } from './model';

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
  const base = cleaned.slice(0, 31) || 'Sheet';
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate.toLocaleLowerCase('en-US'))) {
    const marker = ` (${suffix})`;
    candidate = `${base.slice(0, 31 - marker.length)}${marker}`;
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

async function exportDeck(document: AlbatrossDocumentRecord): Promise<DocumentExport> {
  if (document.model.kind !== 'deck') throw new Error('Presentation model mismatch.');
  const presentation = new pptxgen();
  presentation.author = 'Albatross';
  presentation.subject = document.title;
  presentation.title = document.title;
  presentation.layout = 'LAYOUT_WIDE';
  for (const source of document.model.slides) {
    const slide = presentation.addSlide();
    if (source.background) {
      slide.background = { color: presentationColor(source.background, 'FFFFFF') };
    }
    for (const element of source.elements) {
      const x = (element.x / 100) * 13.333;
      const y = (element.y / 100) * 7.5;
      const w = (element.width / 100) * 13.333;
      const h = (element.height / 100) * 7.5;
      if (element.type === 'shape') {
        slide.addShape(presentation.ShapeType.rect, {
          x,
          y,
          w,
          h,
          fill: { color: presentationColor(element.fill, 'E8EEF5') },
          line: { color: presentationColor(element.color, '94A3B8') },
        });
      } else {
        slide.addText(element.text || '', {
          x,
          y,
          w,
          h,
          fontFace: 'Aptos',
          fontSize: element.fontSize || (element.role === 'title' ? 28 : 16),
          bold: element.role === 'title',
          color: presentationColor(element.color, '17202A'),
          margin: 0.08,
          valign: 'middle',
          breakLine: false,
        });
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
