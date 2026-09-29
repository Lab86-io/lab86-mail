import { createHash } from 'node:crypto';
import { api, convexMutation, convexQuery } from '../hosted/convex';
import { downloadNylasAttachment } from '../nylas/provider';
import { nylasErrorStatus } from '../nylas/retry';
import {
  ATTACHMENT_STORE_MAX_BYTES,
  attachmentMimeBase,
  attachmentSizeSkipReason,
  messageSkipReason,
} from './store-policy';

// The one read path for mail attachment files. Every download site (the
// attachment route, the suggestion action, card and draft attachments, and
// the content index) calls it. It reads our own encrypted storage first, and
// it goes to the provider (Nylas, or the direct Google adapter) only when
// the file is not stored. What it fetches, it stores (lazy fill).

export interface MailAttachmentRef {
  userId: string;
  /** accountId; a grant id or an email also resolves. */
  account: string;
  messageId: string;
  attachmentId: string;
}

export interface MailAttachmentHint {
  filename?: string;
  mimeType?: string;
  size?: number;
  receivedAt?: number;
}

/**
 * `always`: store the file when it is not larger than the storage cap (a
 * person asked for it). `policy`: store only the files that the queue policy
 * takes. `never`: do not store.
 */
export type MailAttachmentFill = 'always' | 'policy' | 'never';

export interface OpenedMailAttachment {
  stream: ReadableStream<Uint8Array>;
  source: 'store' | 'provider';
  filename?: string;
  mimeType?: string;
  size?: number;
}

export interface MailAttachmentBytes {
  bytes: Uint8Array;
  source: 'store' | 'provider';
  filename?: string;
  mimeType?: string;
}

interface StoredLookup {
  accountId: string;
  connected: boolean;
  file: { url: string; filename: string; mimeType: string; size: number } | null;
  corpus: {
    filename?: string;
    mimeType?: string;
    size?: number;
    receivedAt: number;
    labels: string[];
  } | null;
}

export interface ClaimedAttachment {
  queueId: string;
  accountId: string;
  providerMessageId: string;
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
  attempts: number;
}

type StoreStatus = 'stored' | 'skipped' | 'too_large';

const defaults = {
  convexQuery,
  convexMutation,
  downloadNylasAttachment,
  fetch: (input: string, init?: RequestInit) => fetch(input, init),
};
export type MailFileDeps = typeof defaults;

/** A file that is larger than the caller's limit. The message names the size limit. */
export class AttachmentTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`File exceeds the size limit (${Math.round(limit / 1e6)} MB).`);
    this.name = 'AttachmentTooLargeError';
  }
}

/** True for an error that a later try cannot fix: 403, 404, 410, or a file over the limit. */
export function isPermanentAttachmentError(error: unknown) {
  if (error instanceof AttachmentTooLargeError) return true;
  return [403, 404, 410].includes(Number(nylasErrorStatus(error)));
}

function describeError(error: unknown) {
  const status = nylasErrorStatus(error);
  const message = error instanceof Error ? error.message : String(error);
  return (status ? `${status} ${message}` : message).slice(0, 300);
}

function toWebStream(body: unknown): ReadableStream<Uint8Array> {
  if (body instanceof ReadableStream) return body as ReadableStream<Uint8Array>;
  return new Response(body as BodyInit).body as ReadableStream<Uint8Array>;
}

/** All bytes of a stream, or null when it is larger than `limit` (the rest is not read). */
export async function readBounded(stream: ReadableStream<Uint8Array>, limit: number) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

type Defer = (task: () => Promise<unknown>) => void;

/**
 * Runs a store after the caller returns, through `defer` (Next `after` in a
 * route) or as a detached promise. A failed store goes to the log only: the
 * reader has the file already, and the queue or the next read stores it.
 */
function scheduleStore(defer: Defer | undefined, task: () => Promise<unknown>) {
  const guarded = () =>
    task().catch((error) => console.error('[mail-files] store failed:', describeError(error)));
  if (defer) defer(guarded);
  else void guarded();
}

async function lookupStored(ref: MailAttachmentRef, deps: MailFileDeps) {
  try {
    return await deps.convexQuery<StoredLookup | null>(api.mailAttachments.getStoredFile, {
      userId: ref.userId,
      account: ref.account,
      providerMessageId: ref.messageId,
      attachmentId: ref.attachmentId,
    });
  } catch (error) {
    // Storage is an aid: when Convex does not answer, the provider serves.
    console.warn('[mail-files] stored lookup failed:', describeError(error));
    return undefined;
  }
}

async function openStored(url: string, deps: MailFileDeps) {
  try {
    const response = await deps.fetch(url);
    if (response.ok && response.body) return response.body as ReadableStream<Uint8Array>;
    await response.body?.cancel();
    console.warn('[mail-files] stored file read failed:', response.status);
  } catch (error) {
    console.warn('[mail-files] stored file read failed:', describeError(error));
  }
  return null;
}

/** Whether a provider read may go to storage. `size` is the real size when the bytes are read. */
function fillAllowed(
  fill: MailAttachmentFill,
  lookup: StoredLookup,
  hint: MailAttachmentHint,
  now: number,
  size?: number,
) {
  if (fill === 'never' || !lookup.connected) return false;
  const file = {
    size: size ?? (lookup.corpus?.size || hint.size),
    mimeType: lookup.corpus?.mimeType || hint.mimeType,
  };
  if (fill === 'always') return attachmentSizeSkipReason({ ...file, isInline: false }) === null;
  const receivedAt = lookup.corpus?.receivedAt ?? hint.receivedAt;
  if (receivedAt === undefined) return false;
  return (
    messageSkipReason({ receivedAt, labels: lookup.corpus?.labels }, now) === null &&
    attachmentSizeSkipReason(file) === null
  );
}

interface Opened {
  opened: OpenedMailAttachment;
  lookup: StoredLookup | null | undefined;
}

async function open(ref: MailAttachmentRef, hint: MailAttachmentHint, deps: MailFileDeps) {
  const lookup = await lookupStored(ref, deps);
  // The query answered, and no account of this user matches.
  if (lookup === null) return null;
  if (lookup?.file) {
    const stream = await openStored(lookup.file.url, deps);
    if (stream) {
      const { filename, mimeType, size } = lookup.file;
      return { lookup, opened: { stream, source: 'store', filename, mimeType, size } } satisfies Opened;
    }
  }
  if (lookup && !lookup.connected) return null;
  const body = await deps.downloadNylasAttachment({
    userId: ref.userId,
    account: lookup?.accountId ?? ref.account,
    messageId: ref.messageId,
    attachmentId: ref.attachmentId,
  });
  if (!body) return null;
  return {
    lookup,
    opened: {
      stream: toWebStream(body),
      source: 'provider',
      filename: lookup?.corpus?.filename || hint.filename,
      mimeType: lookup?.corpus?.mimeType || hint.mimeType,
      size: lookup?.corpus?.size || hint.size,
    },
  } satisfies Opened;
}

function storeTarget(ref: MailAttachmentRef, lookup: StoredLookup, opened: OpenedMailAttachment) {
  return {
    userId: ref.userId,
    accountId: lookup.accountId,
    providerMessageId: ref.messageId,
    attachmentId: ref.attachmentId,
    filename: opened.filename || 'attachment',
    mimeType: opened.mimeType || 'application/octet-stream',
  };
}

/**
 * Opens an attachment as a stream, for the attachment route. A file from the
 * provider goes to the reader at once; a copy goes to storage through
 * `defer` when `fill` allows it and the file is within the storage cap.
 * Null when the account is not the user's, or not connected and nothing is
 * stored, or the provider has no file.
 */
export async function openMailAttachment(
  ref: MailAttachmentRef,
  options: {
    fill?: MailAttachmentFill;
    hint?: MailAttachmentHint;
    defer?: Defer;
  } = {},
  deps: MailFileDeps = defaults,
): Promise<OpenedMailAttachment | null> {
  const hint = options.hint ?? {};
  const result = await open(ref, hint, deps);
  if (!result) return null;
  const { opened, lookup } = result;
  if (opened.source === 'store' || !lookup || !fillAllowed(options.fill ?? 'never', lookup, hint, Date.now()))
    return opened;
  const [served, copy] = opened.stream.tee();
  const target = storeTarget(ref, lookup, opened);
  scheduleStore(options.defer, async () => {
    const bytes = await readBounded(copy, ATTACHMENT_STORE_MAX_BYTES);
    if (bytes) await storeMailAttachmentBytes({ ...target, bytes }, deps);
  });
  return { ...opened, stream: served };
}

/**
 * Reads an attachment into memory, for the callers that parse or re-send
 * it. It throws AttachmentTooLargeError above `maxBytes`. A file from the
 * provider goes to storage when `fill` allows it.
 */
export async function readMailAttachmentBytes(
  ref: MailAttachmentRef,
  options: {
    maxBytes?: number;
    fill?: MailAttachmentFill;
    hint?: MailAttachmentHint;
    defer?: Defer;
  } = {},
  deps: MailFileDeps = defaults,
): Promise<MailAttachmentBytes | null> {
  const hint = options.hint ?? {};
  const maxBytes = options.maxBytes ?? ATTACHMENT_STORE_MAX_BYTES;
  const result = await open(ref, hint, deps);
  if (!result) return null;
  const { opened, lookup } = result;
  const bytes = await readBounded(opened.stream, maxBytes);
  if (!bytes) throw new AttachmentTooLargeError(maxBytes);
  if (
    opened.source === 'provider' &&
    lookup &&
    fillAllowed(options.fill ?? 'never', lookup, hint, Date.now(), bytes.byteLength)
  ) {
    const target = storeTarget(ref, lookup, opened);
    scheduleStore(options.defer, () => storeMailAttachmentBytes({ ...target, bytes }, deps));
  }
  return { bytes, source: opened.source, filename: opened.filename, mimeType: opened.mimeType };
}

/**
 * Stores the bytes of one attachment: the hash links a file that the user
 * has already, or the bytes go up to Convex storage. A mailbox that is not
 * live keeps nothing (`skipped`).
 */
export async function storeMailAttachmentBytes(
  input: {
    userId: string;
    accountId: string;
    providerMessageId: string;
    attachmentId: string;
    filename: string;
    mimeType: string;
    bytes: Uint8Array;
  },
  deps: MailFileDeps = defaults,
): Promise<StoreStatus> {
  if (input.bytes.byteLength > ATTACHMENT_STORE_MAX_BYTES) return 'too_large';
  const record = {
    userId: input.userId,
    accountId: input.accountId,
    providerMessageId: input.providerMessageId,
    attachmentId: input.attachmentId,
    filename: input.filename,
    mimeType: attachmentMimeBase(input.mimeType) || 'application/octet-stream',
    size: input.bytes.byteLength,
    sha256: createHash('sha256').update(input.bytes).digest('hex'),
  };
  const first = await deps.convexMutation<{ status: StoreStatus | 'upload' }>(
    api.mailAttachments.recordFile,
    record,
  );
  if (first.status !== 'upload') return first.status;
  const uploadUrl = await deps.convexMutation<string>(api.mailAttachments.uploadUrl, {});
  // The stored copy is never served from its own URL, and an opaque type
  // keeps it from rendering anywhere if its URL leaks.
  const response = await deps.fetch(uploadUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: input.bytes as unknown as BodyInit,
  });
  if (!response.ok) throw new Error(`Attachment upload failed (${response.status}).`);
  const { storageId } = (await response.json()) as { storageId: string };
  const second = await deps.convexMutation<{ status: StoreStatus | 'upload' }>(
    api.mailAttachments.recordFile,
    { ...record, storageId },
  );
  return second.status === 'upload' ? 'skipped' : second.status;
}

// One process stores at most this many queued files at the same time, so a
// tick for many users cannot hold many large files in memory.
const INGEST_SLOTS = 2;
let ingestActive = 0;
const ingestWaiting: Array<() => void> = [];

async function withIngestSlot<T>(task: () => Promise<T>): Promise<T> {
  if (ingestActive >= INGEST_SLOTS) await new Promise<void>((resolve) => ingestWaiting.push(resolve));
  ingestActive += 1;
  try {
    return await task();
  } finally {
    ingestActive -= 1;
    ingestWaiting.shift()?.();
  }
}

async function ingestClaimed(userId: string, item: ClaimedAttachment, deps: MailFileDeps) {
  const body = await deps.downloadNylasAttachment({
    userId,
    account: item.accountId,
    messageId: item.providerMessageId,
    attachmentId: item.attachmentId,
  });
  if (!body) throw new Error('The mailbox is not connected.');
  const bytes = await readBounded(toWebStream(body), ATTACHMENT_STORE_MAX_BYTES);
  if (!bytes) throw new AttachmentTooLargeError(ATTACHMENT_STORE_MAX_BYTES);
  if (attachmentSizeSkipReason({ ...item, size: bytes.byteLength })) return 'small_inline' as const;
  return storeMailAttachmentBytes(
    {
      userId,
      accountId: item.accountId,
      providerMessageId: item.providerMessageId,
      attachmentId: item.attachmentId,
      filename: item.filename,
      mimeType: item.mimeType,
      bytes,
    },
    deps,
  );
}

/**
 * Stores the due queued files of one user (the mail-attachments cron). Each
 * file goes through the provider path. A permanent error, or a file that
 * the policy refuses after the download, is recorded and not tried again.
 */
export async function drainMailAttachmentQueue(userId: string, deps: MailFileDeps = defaults) {
  const items = await deps.convexMutation<ClaimedAttachment[]>(api.mailAttachments.claimQueue, { userId });
  const counts = { claimed: items.length, stored: 0, skipped: 0, failed: 0 };
  for (const item of items) {
    await withIngestSlot(async () => {
      try {
        const status = await ingestClaimed(userId, item, deps);
        if (status === 'stored') {
          counts.stored += 1;
          return;
        }
        counts.skipped += 1;
        if (status === 'small_inline' || status === 'too_large')
          await deps.convexMutation(api.mailAttachments.failQueueItem, {
            userId,
            queueId: item.queueId,
            permanent: true,
            error:
              status === 'small_inline' ? 'Inline part below the size floor.' : 'File over the size cap.',
          });
      } catch (error) {
        counts.failed += 1;
        await deps
          .convexMutation(api.mailAttachments.failQueueItem, {
            userId,
            queueId: item.queueId,
            permanent: isPermanentAttachmentError(error),
            error: describeError(error),
          })
          .catch((reportError) =>
            console.error('[mail-files] could not record a failure:', describeError(reportError)),
          );
      }
    });
  }
  return counts;
}
