// Isomorphic capability gate shared by editor controls, tools, and provider writes.

export const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';

/** The editor that opens a Google-native file. */
export type GoogleNativeEditor = 'albatross' | 'office';

/**
 * A Google Doc always opens in the Albatross editor, also when Office is on.
 * Its save sends `documents.batchUpdate` with the `documents` scope, which
 * writes to a Doc that Albatross did not make. The Office editor saves with a
 * Drive upload, and for such a Doc that upload needs the full `drive` scope,
 * which Albatross does not ask for (docs/google-verification/scopes.md). A
 * Sheet or Slides file keeps the Office editor when Office is on.
 */
export function googleNativeEditor(mimeType: string, officeEnabled: boolean): GoogleNativeEditor {
  if (mimeType === GOOGLE_DOC_MIME) return 'albatross';
  return officeEnabled ? 'office' : 'albatross';
}

/** Shown when a Google Doc comes to the Office working copy, for example from an old page. */
export const GOOGLE_DOC_OFFICE_OPEN_REFUSED =
  'Albatross opens a Google Doc in its own editor, which saves your edits to the Doc. Go back to Files and open the Doc again.';

/** Shown when an Office copy of a Google Doc tries to replace the Doc in Google Drive. */
export const GOOGLE_DOC_OFFICE_SAVE_REFUSED =
  'Albatross saves a Google Doc to Google only from its own editor. Open the original Doc from Files to save your edits there. This copy stays in Albatross.';

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

export const LINKED_GOOGLE_FILE_SYNC_LIMITATION =
  'Sync is unavailable for this file because it is linked to a Google original that Albatross cannot write back without loss. Import the latest Google changes, or open the original in Google to edit it.';

/**
 * A spreadsheet or deck linked to an existing Google file can be imported but
 * never written back: the provider writer refuses it (DOC-3). Only documents
 * sync to their Google original.
 */
export function googleLinkedFileSyncLimitation(
  kind: string | undefined,
  google: { fileId?: string } | null | undefined,
): string | null {
  return google?.fileId && kind !== 'doc' ? LINKED_GOOGLE_FILE_SYNC_LIMITATION : null;
}
