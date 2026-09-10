import type { DocumentKind } from './model';

export class GoogleDocumentFidelityError extends Error {
  constructor(
    message = 'This file contains content Albatross cannot safely preserve. Open it in Google to edit the original.',
  ) {
    super(message);
    this.name = 'GoogleDocumentFidelityError';
  }
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
    const paragraph = item.paragraph;
    if (!paragraph || paragraph.bullet) return blocked;
    if (Object.keys(paragraph).some((key) => !['elements', 'paragraphStyle'].includes(key))) return blocked;
    const style = paragraph.paragraphStyle || {};
    if (Object.keys(style).some((key) => !['namedStyleType', 'direction'].includes(key))) return blocked;
    if (style.direction && style.direction !== 'LEFT_TO_RIGHT') return blocked;
    if (
      style.namedStyleType &&
      !['NORMAL_TEXT', 'HEADING_1', 'HEADING_2', 'HEADING_3'].includes(style.namedStyleType)
    )
      return blocked;
    if (!Array.isArray(paragraph.elements)) return blocked;
    for (const element of paragraph.elements) {
      if (
        !element.textRun ||
        Object.keys(element).some((key) => !['startIndex', 'endIndex', 'textRun'].includes(key))
      )
        return blocked;
      if (Object.keys(element.textRun).some((key) => !['content', 'textStyle'].includes(key))) return blocked;
      if (Object.keys(element.textRun.textStyle || {}).length) return blocked;
    }
  }
  return { editable: true };
}

export function assertGoogleFileEditable(kind: DocumentKind, source?: unknown) {
  const permission = googleFileEditability(kind, source);
  if (!permission.editable) throw new GoogleDocumentFidelityError(permission.reason);
}
