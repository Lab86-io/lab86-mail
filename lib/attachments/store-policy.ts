import { labelsHaveRole } from '../mail/search/folders';

// Attachment file storage policy (CASA and Google verification, 2026-09-28).
//
// The app keeps a copy of mail attachment files in Convex file storage, which
// encrypts the files at rest. The background queue (convex/mailAttachments.ts)
// stores only the files that pass this policy:
//   - the account is live (connected);
//   - the message arrived in the last ATTACHMENT_STORE_WINDOW_DAYS days;
//   - the message is not in spam or trash;
//   - the file is not larger than ATTACHMENT_STORE_MAX_BYTES;
//   - the file is not an inline part smaller than ATTACHMENT_INLINE_MIN_BYTES
//     (tracking pixels and spacer images).
// A file that a person opens is stored when it is not larger than
// ATTACHMENT_STORE_MAX_BYTES. Account removal, user deletion, message
// deletion, and the dead-account purge delete the stored files.

const DAY_MS = 86_400_000;

/** The queue stores the files of mail that arrived in this many days. */
export const ATTACHMENT_STORE_WINDOW_DAYS = 60;
export const ATTACHMENT_STORE_WINDOW_MS = ATTACHMENT_STORE_WINDOW_DAYS * DAY_MS;

/** No file larger than this goes into storage. It is the usual mail provider limit. */
export const ATTACHMENT_STORE_MAX_BYTES = 25 * 1024 * 1024;

/** An inline part smaller than this is a tracking pixel or a spacer image. The queue skips it. */
export const ATTACHMENT_INLINE_MIN_BYTES = 4 * 1024;

/** The most files of one message that the queue takes. */
export const ATTACHMENT_STORE_MAX_FILES_PER_MESSAGE = 20;

export type AttachmentSkipReason =
  | 'no_id'
  | 'too_large'
  | 'small_inline'
  | 'outside_window'
  | 'spam_or_trash';

export interface StorePolicyFile {
  attachmentId?: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  /** The provider flag for an inline part. Stored metadata does not have it yet. */
  isInline?: boolean;
}

export interface StorePolicyMessage {
  receivedAt: number;
  labels?: readonly string[];
  attachments?: readonly unknown[];
}

export interface QueueableAttachment {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

/** The media type without parameters, in lower case ("image/png; name=x" gives "image/png"). */
export function attachmentMimeBase(mime: string | null | undefined): string {
  return String(mime || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
}

/**
 * True for an inline part. The provider flag decides when it is present. With
 * no flag, an image counts as inline, because the stored metadata has no flag
 * and a small image in mail is almost always a pixel or a spacer.
 */
export function isInlinePart(file: StorePolicyFile): boolean {
  return file.isInline ?? attachmentMimeBase(file.mimeType).startsWith('image/');
}

/** The size rules. A size of 0 is unknown, and the download checks the real size. */
export function attachmentSizeSkipReason(file: StorePolicyFile): 'too_large' | 'small_inline' | null {
  const size = Number(file.size) || 0;
  if (size > ATTACHMENT_STORE_MAX_BYTES) return 'too_large';
  if (size > 0 && size < ATTACHMENT_INLINE_MIN_BYTES && isInlinePart(file)) return 'small_inline';
  return null;
}

/** The message rules: the time window, and no spam or trash. */
export function messageSkipReason(
  message: Pick<StorePolicyMessage, 'receivedAt' | 'labels'>,
  now: number,
): 'outside_window' | 'spam_or_trash' | null {
  if (!(Number(message.receivedAt) >= now - ATTACHMENT_STORE_WINDOW_MS)) return 'outside_window';
  const labels = message.labels || [];
  if (labelsHaveRole(labels, 'SPAM') || labelsHaveRole(labels, 'TRASH')) return 'spam_or_trash';
  return null;
}

/** Why the queue must not store this file, or null when it can. */
export function queueSkipReason(
  file: StorePolicyFile,
  message: Pick<StorePolicyMessage, 'receivedAt' | 'labels'>,
  now: number,
): AttachmentSkipReason | null {
  if (!file.attachmentId) return 'no_id';
  return messageSkipReason(message, now) ?? attachmentSizeSkipReason(file);
}

function policyFile(raw: unknown): StorePolicyFile {
  const file = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const id = file.attachmentId ?? file.id;
  const inline = file.isInline ?? file.is_inline;
  return {
    attachmentId: typeof id === 'string' ? id : undefined,
    filename: String(file.filename || file.name || 'attachment'),
    mimeType: String(file.mimeType || file.contentType || file.content_type || 'application/octet-stream'),
    size: Number(file.size) || 0,
    ...(typeof inline === 'boolean' ? { isInline: inline } : {}),
  };
}

/** The files of one stored message that the queue takes, at most ATTACHMENT_STORE_MAX_FILES_PER_MESSAGE. */
export function queueableAttachments(message: StorePolicyMessage, now: number): QueueableAttachment[] {
  const raw = Array.isArray(message.attachments) ? message.attachments : [];
  if (!raw.length || messageSkipReason(message, now)) return [];
  const seen = new Set<string>();
  const out: QueueableAttachment[] = [];
  for (const entry of raw) {
    const file = policyFile(entry);
    if (queueSkipReason(file, message, now) || seen.has(file.attachmentId as string)) continue;
    seen.add(file.attachmentId as string);
    out.push({
      attachmentId: file.attachmentId as string,
      filename: (file.filename as string).slice(0, 500),
      mimeType: (file.mimeType as string).slice(0, 255),
      size: file.size as number,
    });
    if (out.length >= ATTACHMENT_STORE_MAX_FILES_PER_MESSAGE) break;
  }
  return out;
}
