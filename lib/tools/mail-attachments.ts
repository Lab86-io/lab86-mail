// mail_attachment_save: one attachment of a received message into Files, so
// pdf_form_fields and pdf_form_fill can read it (for example a payer's own
// W-9 or direct deposit form). The bytes come through the shared mail
// attachment read path (lib/attachments/fetch-store.ts). The type check and
// the file name use the web file rules (lib/web/file-pull.ts): PDF, DOCX,
// XLSX, PPTX, CSV, PNG, or JPEG, the first bytes must agree, max 25 MB.

import { z } from 'zod';
import { fetchEmailAttachment } from '../attachments/fetch-store';
import { SAVED_FILE_MAX_BYTES, SavedFileError, saveFileBytes } from '../files/saved-files';
import { getNylasMessage } from '../nylas/provider';
import { nylasErrorStatus } from '../nylas/retry';
import type { Attachment } from '../shared/types';
import { detectWebFile, SAVE_FILE_KINDS, WEB_FILE_KINDS, WebFileError, webFileName } from '../web/file-pull';
import { defineTool } from './registry';

const defaults = {
  fetchEmailAttachment,
  getMessage: getNylasMessage,
  saveFileBytes,
};
let deps = defaults;
export function __setMailAttachmentSaveDepsForTest(overrides: Partial<typeof defaults> = {}) {
  deps = { ...defaults, ...overrides };
}

const ALLOWED = SAVE_FILE_KINDS.map((kind) => WEB_FILE_KINDS[kind].label).join(', ');
const TOO_LARGE = 'The attachment is larger than 25 MB.';
const NOT_FOUND =
  'No attachment has this id, or the mailbox is not connected. Get messageId and attachmentId from read_thread or list_attachments.';

/** The name, type, and size of the attachment, from the message. Null when the provider does not answer. */
async function attachmentInfo(
  userId: string,
  account: string,
  messageId: string,
  attachmentId: string,
): Promise<Attachment | null> {
  try {
    const message = await deps.getMessage({ userId, account, id: messageId });
    return message?.attachments?.find((attachment) => attachment.attachmentId === attachmentId) ?? null;
  } catch {
    // The info is a hint only. The read below decides if the attachment is there.
    return null;
  }
}

/** A plain sentence for a failed attachment read. */
function readError(error: unknown): Error {
  const message = error instanceof Error ? error.message : '';
  if (/too large/i.test(message)) return new Error(TOO_LARGE);
  if (/not connected|not found/i.test(message) || [403, 404, 410].includes(Number(nylasErrorStatus(error))))
    return new Error(NOT_FOUND);
  console.warn('[mail_attachment_save] read failed:', nylasErrorStatus(error) ?? 'no status');
  return new Error('The mail provider did not give the attachment. Try again later.');
}

/** A plain sentence for a refused type. The web wording ("address") does not apply to mail. */
function typeError(error: WebFileError): Error {
  if (error.code === 'page')
    return new Error(`This attachment is a web page, not a supported file type. Allowed: ${ALLOWED}.`);
  return new Error(error.message);
}

export const mailAttachmentSave = defineTool({
  name: 'mail_attachment_save',
  description:
    "Save one attachment of a received message in the user's Files (PDF, Word, Excel, PowerPoint, CSV, PNG, JPEG; max 25 MB), so pdf_form_fields and pdf_form_fill can read it. Get messageId and attachmentId from read_thread or list_attachments. Use this for a form that a person sent (for example a payer's own W-9 or direct deposit form). Returns fileId, title, openPath, size, contentType, sha256.",
  category: 'mail',
  mutating: true,
  risk: 'write_self',
  input: z.object({
    account: z.string().min(1).max(500).describe('The connected mail account of the message.'),
    messageId: z.string().min(1).max(1_000).describe('The messageId from read_thread.'),
    attachmentId: z
      .string()
      .min(1)
      .max(1_000)
      .describe('The attachmentId from read_thread or list_attachments.'),
    name: z
      .string()
      .max(120)
      .optional()
      .describe('The file name to show in Files, for example "Form W-9.pdf". Default: the attachment name.'),
  }),
  output: z.object({
    ok: z.boolean(),
    fileId: z.string(),
    title: z.string(),
    openPath: z.string(),
    size: z.number(),
    contentType: z.string(),
    sha256: z.string(),
  }),
  async handler({ account, messageId, attachmentId, name }, ctx) {
    const userId = ctx.userId;
    if (!userId) throw new Error('Sign in to save a file.');
    const info = await attachmentInfo(userId, account, messageId, attachmentId);
    // A size the provider gives stops a large file before the download.
    if (info && info.size > SAVED_FILE_MAX_BYTES) throw new Error(TOO_LARGE);
    const requested = name?.trim() || undefined;
    let blob: Awaited<ReturnType<typeof fetchEmailAttachment>>;
    try {
      blob = await deps.fetchEmailAttachment(
        userId,
        account,
        attachmentId,
        messageId,
        info?.filename || requested,
      );
    } catch (error) {
      throw readError(error);
    }
    const bytes = blob.bytes;
    if (!bytes.byteLength) throw new Error('The attachment is empty.');
    if (bytes.byteLength > SAVED_FILE_MAX_BYTES) throw new Error(TOO_LARGE);
    try {
      // The bytes decide the type. The attachment's own name and type are
      // hints, and a hint that disagrees with the bytes is refused.
      const kind = detectWebFile(
        bytes,
        { contentType: info?.mimeType || blob.contentType, name: info?.filename || blob.name },
        SAVE_FILE_KINDS,
      );
      const saved = await deps.saveFileBytes({
        userId,
        bytes,
        name: webFileName(requested || info?.filename || blob.name, kind),
        contentType: WEB_FILE_KINDS[kind].contentType,
        origin: 'mail',
      });
      return {
        ok: true,
        fileId: saved.fileId,
        title: saved.title,
        openPath: saved.openPath,
        size: saved.size,
        contentType: saved.contentType,
        sha256: saved.sha256,
      };
    } catch (error) {
      if (error instanceof WebFileError) throw typeError(error);
      if (error instanceof SavedFileError) throw new Error(error.message);
      throw error;
    }
  },
});
