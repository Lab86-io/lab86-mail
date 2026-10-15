// Files on a draft (docs/albatross-goal-runs.md G3, "Attachments on drafts").
//
// A draft keeps references only: `{ source: 'file', fileId, provider, format,
// name }`. The bytes are read from storage when the mail sends; the send path
// never fetches an address that a model or a page gave.
//
//   upload     a saved file in Files (agentUploads): its stored bytes. A file
//              with sealed fields fills them at send time
//              (lib/files/materialize.ts), for the recipients of this mail.
//   office     a Word, Excel, or PowerPoint file: its newest version, or a PDF
//              copy from the document server (`format: 'pdf'`).
//   albatross  an Albatross document: the export of today (DOCX, XLSX, PPTX).

import { z } from 'zod';
import { exportDocument } from '../documents/export';
import { exportOfficePdf } from '../documents/office-pdf';
import { OFFICE_MIME, type OfficeExtension, readOfficeResponse } from '../documents/office-security';
import { getOfficeFile } from '../documents/office-service';
import { getDocument } from '../documents/service';
import { consumeSendGrants } from '../secure/send-grants';
import { sanitizeFilename } from '../shared/files';
import type { DraftAttachment } from '../shared/types';
import { checkSavedFileSend, materializeSavedFile } from './materialize';
import { getSavedFileRow, readSavedFileBytes, SAVED_FILE_MAX_BYTES } from './saved-files';

export const DRAFT_ATTACHMENTS_MAX = 10;
/** The most bytes that the files of one mail may have together (the compose route uses the same limit). */
export const DRAFT_ATTACHMENTS_MAX_BYTES = SAVED_FILE_MAX_BYTES;

/** One attachment as a client or the model sends it. Model-facing: no regex. */
export const draftAttachmentInputSchema = z.object({
  source: z.literal('file').optional(),
  fileId: z
    .string()
    .min(1)
    .max(200)
    .describe(
      'The id of the file: a fileId from Files, web_file_save, or pdf_form_fill (provider upload), a Word, Excel, or PowerPoint file id (provider office), or an Albatross document id (provider albatross).',
    ),
  provider: z
    .enum(['office', 'upload', 'albatross'])
    .describe(
      'upload: a saved file such as a PDF. office: a Word, Excel, or PowerPoint file. albatross: an Albatross document.',
    ),
  format: z
    .enum(['pdf', 'native'])
    .optional()
    .describe('pdf sends a Word, Excel, or PowerPoint file as a PDF. Default native.'),
  name: z.string().max(200).optional().describe('The file name in the mail. Default: the name in Files.'),
});
export type DraftAttachmentInput = z.infer<typeof draftAttachmentInputSchema>;

export const draftAttachmentsInputSchema = z.array(draftAttachmentInputSchema).max(DRAFT_ATTACHMENTS_MAX);

/** A refusal with copy for the user (or the model) and an HTTP status. */
export class DraftAttachmentError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'DraftAttachmentError';
  }
}

/** A sealed file on a held send: the bytes fill when the hold ends, never before. */
export interface HeldSealedAttachment {
  fileId: string;
  filename: string;
  /** The send key, when the client showed a valid "Allow for this send" token. */
  sendKey?: string;
}

/** The attachment shape that the Nylas send takes (and the outbox stores). */
export interface SendAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
  size: number;
}

export const draftAttachmentDeps = {
  getFile: getSavedFileRow,
  readBytes: readSavedFileBytes,
  getOfficeFile,
  readOffice: async (url: string) =>
    new Uint8Array(
      await readOfficeResponse(await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(45_000) })),
    ),
  exportOfficePdf,
  getDocument,
  exportDocument,
  checkSend: (
    userId: string,
    fileId: string,
    recipients: ReadonlyArray<string | null | undefined>,
    sendKey?: string,
  ) => checkSavedFileSend(userId, fileId, recipients, sendKey),
  materialize: materializeSavedFile,
  consumeSendGrants: (userId: string, sendKey: string) => consumeSendGrants(userId, sendKey),
};

const KIND_EXTENSION: Record<string, OfficeExtension> = { doc: 'docx', sheet: 'xlsx', deck: 'pptx' };

function withExtension(title: string, extension: string) {
  const base = sanitizeFilename(title || 'file').replace(/\.(docx|xlsx|pptx|pdf)$/i, '');
  return `${base}.${extension}`;
}

function nameOf(input: DraftAttachmentInput, fallback: string) {
  return input.name?.trim() ? sanitizeFilename(input.name.trim()) : sanitizeFilename(fallback);
}

/**
 * Checks each attachment against the user's own files and fills in the name,
 * the type, and the size. Throws DraftAttachmentError for a file that is not
 * the user's, a format that the provider cannot make, or more than 10 files.
 */
export async function checkDraftAttachments(
  userId: string,
  inputs: readonly DraftAttachmentInput[],
  deps: typeof draftAttachmentDeps = draftAttachmentDeps,
): Promise<DraftAttachment[]> {
  if (!userId) throw new DraftAttachmentError('Sign in to attach files.', 401);
  const unique = new Map<string, DraftAttachmentInput>();
  for (const input of inputs) {
    const format = input.format ?? 'native';
    unique.set(`${input.provider}:${input.fileId}:${format}`, { ...input, format });
  }
  if (unique.size > DRAFT_ATTACHMENTS_MAX)
    throw new DraftAttachmentError(`A mail takes ${DRAFT_ATTACHMENTS_MAX} files at most.`);
  const out: DraftAttachment[] = [];
  for (const input of unique.values()) {
    const format = input.format ?? 'native';
    if (input.provider === 'upload') {
      const row = await deps.getFile(userId, input.fileId);
      if (!row) throw new DraftAttachmentError('One of the files is not in Files any more.', 404);
      const isPdf = /pdf/i.test(row.contentType || '') || /\.pdf$/i.test(row.name);
      if (format === 'pdf' && !isPdf)
        throw new DraftAttachmentError(
          'A saved file goes as it is. Only Word, Excel, and PowerPoint files convert to PDF.',
        );
      out.push({
        source: 'file',
        fileId: String(row._id),
        provider: 'upload',
        format: 'native',
        name: nameOf(input, row.name),
        size: row.size,
        ...(row.contentType ? { contentType: row.contentType } : {}),
        ...(row.sealedFields?.length ? { sealed: true } : {}),
      });
    } else if (input.provider === 'office') {
      const file = await deps.getOfficeFile(userId, input.fileId);
      if (!file) throw new DraftAttachmentError('One of the files is not in Files any more.', 404);
      const pdf = format === 'pdf';
      out.push({
        source: 'file',
        fileId: file.documentId,
        provider: 'office',
        format,
        name: nameOf(input, withExtension(file.title, pdf ? 'pdf' : file.extension)),
        contentType: pdf ? 'application/pdf' : OFFICE_MIME[file.extension],
        ...(!pdf && file.version?.size ? { size: file.version.size } : {}),
      });
    } else {
      if (format === 'pdf')
        throw new DraftAttachmentError('An Albatross document goes as a Word, Excel, or PowerPoint file.');
      const document = await deps.getDocument(userId, input.fileId);
      if (!document) throw new DraftAttachmentError('One of the files is not in Files any more.', 404);
      const extension = KIND_EXTENSION[document.kind] ?? 'docx';
      out.push({
        source: 'file',
        fileId: document.documentId,
        provider: 'albatross',
        format: 'native',
        name: nameOf(input, withExtension(document.title, extension)),
        contentType: OFFICE_MIME[extension],
      });
    }
  }
  return out;
}

/** True when one of the attachments fills saved details at send time. */
export function hasSealedAttachment(list: readonly DraftAttachment[]): boolean {
  return list.some((attachment) => attachment.provider === 'upload' && attachment.sealed);
}

function sendAttachment(name: string, contentType: string, bytes: Uint8Array): SendAttachment {
  return {
    filename: sanitizeFilename(name),
    contentType: contentType || 'application/octet-stream',
    content: Buffer.from(bytes),
    // Without a size the SDK takes the JSON path, which Nylas caps at 3 MB.
    size: bytes.byteLength,
  };
}

/**
 * The bytes of every attachment, read at send time. With `hold` (an Undo
 * window), a file with sealed fields is checked for the recipients now and
 * comes back in `held`: the outbox keeps the reference, and the bytes fill
 * when the hold ends (fillHeldAttachments). Throws DraftAttachmentError, and
 * the SealedFileError family for a sealed file.
 */
export async function resolveDraftAttachments(
  userId: string,
  list: readonly DraftAttachment[],
  options: {
    recipients: ReadonlyArray<string | null | undefined>;
    hold?: boolean;
    /** Bytes that the rest of the mail already uses (form uploads). */
    usedBytes?: number;
    workId?: string;
    /** The outbox key, only when the client showed a valid "Allow for this send" token. */
    sendKey?: string;
  },
  deps: typeof draftAttachmentDeps = draftAttachmentDeps,
): Promise<{ attachments: SendAttachment[]; held: HeldSealedAttachment[] }> {
  const attachments: SendAttachment[] = [];
  const held: HeldSealedAttachment[] = [];
  let filledSealed = false;
  let total = options.usedBytes ?? 0;
  const count = (bytes: number) => {
    total += bytes;
    if (total > DRAFT_ATTACHMENTS_MAX_BYTES)
      throw new DraftAttachmentError('The files of this mail are larger than 25 MB together.', 413);
  };
  for (const attachment of list.slice(0, DRAFT_ATTACHMENTS_MAX)) {
    if (attachment.provider === 'upload') {
      const row = await deps.getFile(userId, attachment.fileId);
      if (!row) throw new DraftAttachmentError('One of the files is not in Files any more.', 404);
      if (row.sealedFields?.length) {
        if (options.hold) {
          await deps.checkSend(userId, row._id, options.recipients, options.sendKey);
          count(row.size);
          held.push({
            fileId: row._id,
            filename: sanitizeFilename(attachment.name || row.name),
            ...(options.sendKey ? { sendKey: options.sendKey } : {}),
          });
          continue;
        }
        const filled = await deps.materialize(userId, row._id, {
          kind: 'send',
          recipients: options.recipients,
          ...(options.workId ? { workId: options.workId } : {}),
          ...(options.sendKey ? { sendKey: options.sendKey } : {}),
        });
        filledSealed = true;
        count(filled.bytes.byteLength);
        attachments.push(sendAttachment(attachment.name || row.name, filled.contentType, filled.bytes));
        continue;
      }
      count(row.size);
      const bytes = await deps.readBytes(row);
      attachments.push(sendAttachment(attachment.name || row.name, row.contentType || '', bytes));
    } else if (attachment.provider === 'office') {
      if (attachment.format === 'pdf') {
        const pdf = await deps.exportOfficePdf(userId, attachment.fileId);
        count(pdf.bytes.byteLength);
        attachments.push(sendAttachment(attachment.name || pdf.name, 'application/pdf', pdf.bytes));
        continue;
      }
      const file = await deps.getOfficeFile(userId, attachment.fileId);
      if (!file?.version?.url)
        throw new DraftAttachmentError('One of the files is not in Files any more.', 404);
      count(file.version.size);
      const bytes = await deps.readOffice(file.version.url);
      attachments.push(
        sendAttachment(
          attachment.name || withExtension(file.title, file.extension),
          OFFICE_MIME[file.extension],
          bytes,
        ),
      );
    } else {
      const document = await deps.getDocument(userId, attachment.fileId);
      if (!document) throw new DraftAttachmentError('One of the files is not in Files any more.', 404);
      const exported = await deps.exportDocument(document);
      count(exported.bytes.byteLength);
      attachments.push(
        sendAttachment(
          attachment.name || withExtension(document.title, exported.extension),
          exported.contentType,
          exported.bytes,
        ),
      );
    }
  }
  // "Allow for this send" works one time: it is used when every file is filled.
  if (filledSealed && options.sendKey) await deps.consumeSendGrants(userId, options.sendKey);
  return { attachments, held };
}

/** The sealed files of a held send, filled now for its recipients (app/api/cron/mail-outbox). */
export async function fillHeldAttachments(
  userId: string,
  held: readonly HeldSealedAttachment[],
  recipients: ReadonlyArray<string | null | undefined>,
  deps: Pick<typeof draftAttachmentDeps, 'materialize' | 'consumeSendGrants'> = draftAttachmentDeps,
): Promise<SendAttachment[]> {
  const out: SendAttachment[] = [];
  const sendKeys = new Set<string>();
  for (const entry of held.slice(0, DRAFT_ATTACHMENTS_MAX)) {
    const filled = await deps.materialize(userId, entry.fileId, {
      kind: 'send',
      recipients,
      ...(entry.sendKey ? { sendKey: entry.sendKey } : {}),
    });
    if (entry.sendKey) sendKeys.add(entry.sendKey);
    out.push(sendAttachment(entry.filename || filled.name, filled.contentType, filled.bytes));
  }
  for (const sendKey of sendKeys) await deps.consumeSendGrants(userId, sendKey);
  return out;
}
