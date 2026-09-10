/** Isomorphic capability gate shared by editor controls, tools, and provider writes. */
export const ENGINE_GOOGLE_PUBLISH_LIMITATION =
  'Google publishing is unavailable for this full spreadsheet workbook because it would discard formatting, charts, validation, or other workbook data. Download Excel from the editor instead; the original workbook remains unchanged.';
export const RICH_DOCUMENT_GOOGLE_PUBLISH_LIMITATION =
  'Google publishing is unavailable for this rich-text document because its inline formatting cannot yet be preserved by Google sync. Download DOCX instead; the original document remains unchanged.';
export const RICH_DECK_GOOGLE_PUBLISH_LIMITATION =
  'Google publishing is unavailable for this presentation because its backgrounds, shape styling, speaker notes, or colors cannot yet be preserved by Google sync. Download PPTX instead; the original presentation remains unchanged.';

/** Return a user-visible reason whenever the provider writer would lose data. */
export function googleModelWriteLimitation(model: unknown): string | null {
  if (typeof model !== 'object' || model === null) return null;
  const value = model as Record<string, any>;
  if (value.kind === 'sheet' && value.version === 2) return ENGINE_GOOGLE_PUBLISH_LIMITATION;
  if (value.kind === 'doc' && Array.isArray(value.blocks)) {
    const marked = value.blocks.some(
      (block: any) =>
        Array.isArray(block?.runs) &&
        block.runs.some(
          (run: any) =>
            run && ['bold', 'italic', 'underline', 'strike', 'code'].some((mark) => run[mark] === true),
        ),
    );
    if (marked) return RICH_DOCUMENT_GOOGLE_PUBLISH_LIMITATION;
  }
  if (value.kind === 'deck' && Array.isArray(value.slides)) {
    const unsupported = value.slides.some((slide: any) => {
      if (typeof slide?.notes === 'string' && slide.notes.trim()) return true;
      if (
        typeof slide?.background === 'string' &&
        slide.background.trim() &&
        !['white', '#fff', '#ffffff'].includes(slide.background.trim().toLowerCase())
      )
        return true;
      return (
        Array.isArray(slide?.elements) &&
        slide.elements.some((element: any) => {
          if (typeof element?.fill === 'string' && element.fill.trim()) return true;
          if (element?.type === 'shape' && typeof element.color === 'string' && element.color.trim())
            return true;
          // The current writer handles only six-digit hexadecimal text colors.
          return typeof element?.color === 'string' && !/^#[0-9a-f]{6}$/iu.test(element.color);
        })
      );
    });
    if (unsupported) return RICH_DECK_GOOGLE_PUBLISH_LIMITATION;
  }
  return null;
}
