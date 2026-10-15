import { describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ATTACHMENT_COPY,
  AttachmentRows,
  attachmentMeta,
  attachmentSealedNote,
} from '../components/thread/attachment-rows';
import { goalDraftFixture } from '../lib/albatross/thread-fixtures';
import type { DraftAttachment } from '../lib/shared/types';

/* The attachment rows of a draft (docs/albatross-goal-runs.md G3): the name,
 * the kind and the size with no middle dot, a note for a sealed file or a
 * file that converts at send time, and Remove. */

const NOW = Date.UTC(2026, 9, 15, 18, 44, 0);
const attachments = goalDraftFixture(NOW).attachments!;

describe('the meta line', () => {
  test('the kind and the size, then the note', () => {
    expect(attachmentMeta(attachments[0])).toEqual({ line: 'PDF, 84 KB', note: null });
    expect(attachmentMeta(attachments[1])).toEqual({ line: 'Excel file, 21 KB', note: null });
    const word: DraftAttachment = {
      source: 'file',
      fileId: 'doc_1',
      provider: 'office',
      format: 'pdf',
      name: 'Letter.docx',
      size: 10_240,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
    expect(attachmentMeta(word)).toEqual({ line: 'Word file, 10 KB', note: ATTACHMENT_COPY.converted });
    expect(attachmentMeta({ ...word, size: undefined }).line).toBe('Word file');
  });

  test('a sealed file carries the server note, or the fixed line', () => {
    const sealed = { ...attachments[2], sealed: true } as DraftAttachment;
    expect(attachmentSealedNote(sealed)).toBe(ATTACHMENT_COPY.sealed);
    expect(
      attachmentSealedNote({
        ...sealed,
        sealedNote: 'The tax ID fills in when you send.',
      } as DraftAttachment),
    ).toBe('The tax ID fills in when you send.');
    expect(attachmentSealedNote(attachments[2])).toBeNull();
    expect(attachmentMeta(sealed).note).toBe(ATTACHMENT_COPY.sealed);
  });

  test('no meta line joins its parts with a middle dot', () => {
    for (const attachment of attachments) expect(attachmentMeta(attachment).line).not.toContain('·');
  });
});

describe('the rows', () => {
  test('one row per file, with Remove named by the file', () => {
    const html = renderToStaticMarkup(
      <AttachmentRows attachments={attachments} onRemove={() => undefined} />,
    );
    const doc = new JSDOM(html).window.document;
    const rows = [...doc.querySelectorAll('[data-slot="attachment-rows"] li')];
    expect(rows.length).toBe(3);
    expect(rows[0].textContent).toContain('Invoice 0007.pdf');
    expect(rows[0].textContent).toContain('PDF, 84 KB');
    expect(rows[0].querySelector('button')?.getAttribute('aria-label')).toBe('Remove Invoice 0007.pdf');
    expect(rows[2].getAttribute('data-attachment-id')).toBe('upload_w9_filled');
  });

  test('without onRemove the rows are read only, and no rows render for none', () => {
    const html = renderToStaticMarkup(<AttachmentRows attachments={attachments} />);
    expect(new JSDOM(html).window.document.querySelector('button')).toBeNull();
    expect(renderToStaticMarkup(<AttachmentRows attachments={[]} />)).toBe('');
  });
});
