import type { DocumentKind } from './model';

export class GoogleDocumentFidelityError extends Error {
  constructor(
    message = 'This file contains content Albatross cannot safely preserve. Open it in Google to edit the original.',
  ) {
    super(message);
    this.name = 'GoogleDocumentFidelityError';
  }
}

// The quote style the writer (lib/documents/google.ts) applies.
export const GOOGLE_QUOTE_COLOR = '#52606D';
export const GOOGLE_QUOTE_INDENT_PT = 24;

export type GoogleDocBlockType = 'paragraph' | 'heading' | 'bullet' | 'numbered' | 'quote';

function quoteRgb() {
  const hex = GOOGLE_QUOTE_COLOR.slice(1);
  return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
}

function isQuoteTextStyle(style: any): boolean {
  if (!style || Object.keys(style).some((key) => !['italic', 'foregroundColor'].includes(key))) return false;
  if (style.italic !== true) return false;
  const rgb = style.foregroundColor?.color?.rgbColor;
  if (!rgb) return false;
  const expected = quoteRgb();
  return [rgb.red ?? 0, rgb.green ?? 0, rgb.blue ?? 0].every(
    (value: number, index: number) => Math.abs(value - expected[index]) < 0.01,
  );
}

function isQuoteIndent(indent: any): boolean {
  return indent?.unit === 'PT' && Math.abs(Number(indent.magnitude) - GOOGLE_QUOTE_INDENT_PT) < 0.01;
}

// A bullet written from a preset: one level, no own text style except the
// defaults Docs echoes back (for example underline: false).
function listKind(bullet: any, lists: any): 'bullet' | 'numbered' | null {
  if (!bullet || typeof bullet !== 'object') return null;
  if (Object.keys(bullet).some((key) => !['listId', 'nestingLevel', 'textStyle'].includes(key))) return null;
  if (bullet.nestingLevel) return null;
  if (Object.values(bullet.textStyle || {}).some((value) => value !== false)) return null;
  const level = lists?.[bullet.listId]?.listProperties?.nestingLevels?.[0];
  if (!level) return null;
  if (level.glyphSymbol) return 'bullet';
  if (level.glyphType === 'DECIMAL') return 'numbered';
  return null;
}

/**
 * The block type of one Docs paragraph when it is in the subset the writer
 * emits (and so can be written back without loss), else null. The reader and
 * the editability check both use this, so a document the writer saved always
 * opens as editable again (DOC-1).
 */
export function googleDocBlockType(paragraph: any, lists?: any): GoogleDocBlockType | null {
  if (!paragraph || typeof paragraph !== 'object') return null;
  if (Object.keys(paragraph).some((key) => !['elements', 'paragraphStyle', 'bullet'].includes(key)))
    return null;
  const style = paragraph.paragraphStyle || {};
  const allowedStyle = ['namedStyleType', 'direction', 'indentStart', 'indentFirstLine'];
  if (Object.keys(style).some((key) => !allowedStyle.includes(key))) return null;
  if (style.direction && style.direction !== 'LEFT_TO_RIGHT') return null;
  const named = style.namedStyleType || 'NORMAL_TEXT';
  if (!['NORMAL_TEXT', 'HEADING_1', 'HEADING_2', 'HEADING_3'].includes(named)) return null;
  if (!Array.isArray(paragraph.elements)) return null;
  for (const element of paragraph.elements) {
    if (
      !element?.textRun ||
      Object.keys(element).some((key) => !['startIndex', 'endIndex', 'textRun'].includes(key))
    )
      return null;
    if (Object.keys(element.textRun).some((key) => !['content', 'textStyle'].includes(key))) return null;
  }
  const styledRuns = paragraph.elements.filter(
    (element: any) => Object.keys(element.textRun.textStyle || {}).length,
  );

  if (paragraph.bullet) {
    // Docs sets its own list indents; the preset writes them again.
    if (named !== 'NORMAL_TEXT' || styledRuns.length) return null;
    return listKind(paragraph.bullet, lists);
  }
  if (style.indentFirstLine) return null;
  if (style.indentStart) {
    // A quote: indented, and every styled run has the quote style. The
    // closing newline is left unstyled by the writer.
    if (named !== 'NORMAL_TEXT' || !isQuoteIndent(style.indentStart)) return null;
    if (!styledRuns.length) return null;
    return styledRuns.every((element: any) => isQuoteTextStyle(element.textRun.textStyle)) ? 'quote' : null;
  }
  if (styledRuns.length) return null;
  return named === 'NORMAL_TEXT' ? 'paragraph' : 'heading';
}

/** Only the lossless subset may use the semantic editor's whole-body writer. */
export function googleFileEditability(
  kind: DocumentKind,
  source?: any,
): { editable: boolean; reason?: string } {
  const blocked = {
    editable: false,
    reason:
      'Preview only: this file’s formatting or content cannot yet be safely round-tripped. Open the original in Google to edit it.',
  };
  // Spreadsheet/deck imports are bounded projections, not lossless provider models.
  if (kind !== 'doc') return blocked;
  if (!Array.isArray(source?.body?.content)) return blocked;
  if ((source.tabs?.length || 0) > 1 || source.tabs?.some((tab: any) => tab.childTabs?.length))
    return blocked;
  if (/"suggested\w*"\s*:/.test(JSON.stringify(source))) return blocked;
  for (const [index, item] of source.body.content.entries()) {
    // The initial section's geometry is retained; later section boundaries are not.
    if (index === 0 && item.sectionBreak && !item.paragraph && item.endIndex === 1) continue;
    if (!googleDocBlockType(item.paragraph, source.lists)) return blocked;
  }
  return { editable: true };
}

export function assertGoogleFileEditable(kind: DocumentKind, source?: unknown) {
  const permission = googleFileEditability(kind, source);
  if (!permission.editable) throw new GoogleDocumentFidelityError(permission.reason);
}
