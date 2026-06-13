import { api, convexMutation } from '@/lib/hosted/convex';
import { downloadNylasAttachment } from '@/lib/nylas/provider';
import { normalizeUrl } from '@/lib/shared/url';

const boardsApi = (api as any).boards;

// Cap fetched/uploaded attachment size so a runaway URL can't exhaust memory
// or Convex storage. 25 MB matches typical mail-provider attachment limits.
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export interface StoredAttachment {
  name: string;
  storageId: string;
  contentType?: string;
  size: number;
}

interface FetchedBlob {
  bytes: Uint8Array;
  contentType: string;
  name: string;
}

// Download a public web file. Returns bytes + a best-effort name/type.
export async function fetchWebFile(rawUrl: string, fallbackName?: string): Promise<FetchedBlob> {
  const url = normalizeUrl(rawUrl);
  if (!url) throw new Error(`Not a usable URL: ${rawUrl}`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Fetch failed (${response.status}) for ${url}`);
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(`File is too large (${Math.round(buffer.byteLength / 1e6)} MB; max 25 MB).`);
  }
  const contentType = response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
  const name = fallbackName || nameFromUrl(url) || 'download';
  return { bytes: buffer, contentType, name };
}

// Download an attachment off a synced email message.
export async function fetchEmailAttachment(
  userId: string,
  accountRef: string,
  attachmentId: string,
  messageId: string,
  fallbackName?: string,
): Promise<FetchedBlob> {
  const stream = await downloadNylasAttachment({
    userId,
    account: accountRef,
    attachmentId,
    messageId,
  });
  const buffer = new Uint8Array(await new Response(stream as any).arrayBuffer());
  if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Attachment is too large (${Math.round(buffer.byteLength / 1e6)} MB; max 25 MB).`);
  }
  return {
    bytes: buffer,
    contentType: 'application/octet-stream',
    name: fallbackName || 'attachment',
  };
}

// Push bytes into Convex storage via a board-scoped upload URL. Card
// attachments authorize against the board; the returned storageId is what
// gets stored on the card.
export async function storeForCard(
  userId: string,
  cardId: string,
  blob: FetchedBlob,
): Promise<StoredAttachment> {
  const uploadUrl = await convexMutation<string>(boardsApi.generateAttachmentUploadUrl, { userId, cardId });
  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': blob.contentType },
    // Uint8Array is a valid BodyInit; copy to a plain buffer for fetch typing.
    body: blob.bytes as unknown as BodyInit,
  });
  if (!response.ok) throw new Error(`Storage upload failed (${response.status}).`);
  const { storageId } = (await response.json()) as { storageId: string };
  return { name: blob.name, storageId, contentType: blob.contentType, size: blob.bytes.byteLength };
}

function nameFromUrl(url: string): string | undefined {
  try {
    const path = new URL(url).pathname;
    const last = path.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : undefined;
  } catch {
    return undefined;
  }
}
