import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import ExcelJS from 'exceljs';
import pptxgen from 'pptxgenjs';
import type { AlbatrossDocumentRecord, DocBlock } from './model';

export interface DocumentExport {
  bytes: Uint8Array;
  contentType: string;
  extension: 'docx' | 'xlsx' | 'pptx';
}

function paragraphForBlock(block: DocBlock) {
  if (block.type === 'heading') {
    const heading =
      block.level === 1
        ? HeadingLevel.HEADING_1
        : block.level === 3
          ? HeadingLevel.HEADING_3
          : HeadingLevel.HEADING_2;
    return new Paragraph({ text: block.text, heading });
  }
  if (block.type === 'bullet') {
    return new Paragraph({ children: [new TextRun(block.text)], bullet: { level: 0 } });
  }
  if (block.type === 'numbered') {
    return new Paragraph({
      children: [new TextRun(block.text)],
      numbering: { reference: 'ordered', level: 0 },
    });
  }
  if (block.type === 'quote') {
    return new Paragraph({
      children: [new TextRun({ text: block.text, italics: true, color: '52606D' })],
      indent: { left: 500 },
    });
  }
  return new Paragraph({ children: [new TextRun(block.text)] });
}

async function exportDoc(document: AlbatrossDocumentRecord): Promise<DocumentExport> {
  if (document.model.kind !== 'doc') throw new Error('Document model mismatch.');
  const file = new Document({
    title: document.title,
    numbering: {
      config: [
        {
          reference: 'ordered',
          levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: 'left' }],
        },
      ],
    },
    sections: [{ children: document.model.blocks.map(paragraphForBlock) }],
  });
  return {
    bytes: await Packer.toBuffer(file),
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: 'docx',
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

async function exportSheet(document: AlbatrossDocumentRecord): Promise<DocumentExport> {
  if (document.model.kind !== 'sheet') throw new Error('Spreadsheet model mismatch.');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Albatross';
  workbook.created = new Date(document.createdAt);
  for (const tab of document.model.sheets) {
    const worksheet = workbook.addWorksheet(tab.name.slice(0, 31) || 'Sheet');
    for (const [address, cell] of Object.entries(tab.cells)) {
      const position = columnIndex(address);
      if (!position) continue;
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
    if (source.background) slide.background = { color: source.background.replace('#', '') };
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
          fill: { color: (element.fill || '#E8EEF5').replace('#', '') },
          line: { color: (element.color || '#94A3B8').replace('#', '') },
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
          color: (element.color || '#17202A').replace('#', ''),
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
  };
}

export async function exportDocument(document: AlbatrossDocumentRecord): Promise<DocumentExport> {
  if (document.kind === 'doc') return exportDoc(document);
  if (document.kind === 'sheet') return exportSheet(document);
  return exportDeck(document);
}
