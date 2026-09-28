import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { AttachmentTooLargeError, readMailAttachmentBytes } from '@/lib/attachments/mail-files';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { normalizeUrl } from '@/lib/shared/url';

const boardsApi = api.boards;
const agentUploadsApi = api.agentUploads;

// Cap fetched/uploaded attachment size so a runaway URL can't exhaust memory
// or Convex storage. 25 MB matches typical mail-provider attachment limits.
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

// Hostnames we never fetch even if they resolve publicly.
const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata', 'metadata.google.internal']);

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    n = n * 256 + value;
  }
  return n >>> 0;
}

function isBlockedIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true;
  const inRange = (base: string, bits: number) => {
    const b = ipv4ToInt(base);
    if (b === null) return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (b & mask);
  };
  return (
    inRange('0.0.0.0', 8) || // "this" network
    inRange('10.0.0.0', 8) || // RFC1918
    inRange('100.64.0.0', 10) || // CGNAT
    inRange('127.0.0.0', 8) || // loopback
    inRange('169.254.0.0', 16) || // link-local + cloud metadata (169.254.169.254)
    inRange('172.16.0.0', 12) || // RFC1918
    inRange('192.0.0.0', 24) || // IETF protocol assignments
    inRange('192.168.0.0', 16) || // RFC1918
    inRange('198.18.0.0', 15) || // benchmarking
    inRange('224.0.0.0', 4) || // multicast
    inRange('240.0.0.0', 4) // reserved
  );
}

/** The eight 16-bit groups of an IPv6 address, or null. Accepts a dotted IPv4 tail. */
export function ipv6Groups(ip: string): number[] | null {
  let addr = ip.toLowerCase().replace(/^\[|\]$/g, '');
  const zone = addr.indexOf('%');
  if (zone >= 0) addr = addr.slice(0, zone);
  const tail = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const v4 = ipv4ToInt(tail[1]);
    if (v4 === null) return null;
    addr = `${addr.slice(0, -tail[1].length)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const parts = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  const groups = parts.map((part) => (/^[0-9a-f]{1,4}$/.test(part) ? Number.parseInt(part, 16) : Number.NaN));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group)) ? groups : null;
}

function isBlockedIpv6(ip: string): boolean {
  const groups = ipv6Groups(ip);
  if (!groups) return true;
  const v4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
  const zeroPrefix = groups.slice(0, 5).every((group) => group === 0);
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d), and NAT64
  // (64:ff9b::a.b.c.d) addresses reach the IPv4 host, so they get the IPv4 rules.
  if (zeroPrefix && groups[5] === 0xffff) return isBlockedIpv4(v4);
  if (zeroPrefix && groups[5] === 0 && (groups[6] !== 0 || groups[7] > 1)) return isBlockedIpv4(v4);
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) {
    return isBlockedIpv4(v4);
  }
  if (groups.every((group) => group === 0)) return true; // ::
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true; // ::1
  const addr = groups.map((group) => group.toString(16).padStart(4, '0')).join(':');
  // Unique-local (fc00::/7 → fc/fd) and link-local (fe80::/10).
  return (
    addr.startsWith('fc') ||
    addr.startsWith('fd') ||
    addr.startsWith('fe8') ||
    addr.startsWith('fe9') ||
    addr.startsWith('fea') ||
    addr.startsWith('feb') ||
    addr.startsWith('ff') // multicast
  );
}

function isBlockedAddress(ip: string): boolean {
  const type = net.isIP(ip);
  if (type === 4) return isBlockedIpv4(ip);
  if (type === 6) return isBlockedIpv6(ip);
  return true; // not an IP after resolution → block defensively
}

// SSRF guard: confirm a URL points at a public http(s) host. Resolves DNS and
// rejects if the host (or any resolved address) is private/reserved/metadata.
// Returns the validated absolute URL string.
export async function assertPublicHttpUrl(rawUrl: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Not a usable URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported URL scheme: ${url.protocol}`);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new Error('Refusing to fetch an internal host.');
  }
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new Error('Refusing to fetch a private or reserved address.');
    return url.toString();
  }
  const records = await lookup(host, { all: true }).catch(() => [] as { address: string }[]);
  if (!records.length) throw new Error(`Could not resolve host: ${host}`);
  for (const record of records) {
    if (isBlockedAddress(record.address)) {
      throw new Error('Refusing to fetch a host that resolves to a private or reserved address.');
    }
  }
  return url.toString();
}

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
  const normalized = normalizeUrl(rawUrl);
  if (!normalized) throw new Error(`Not a usable URL: ${rawUrl}`);
  // Follow redirects manually so EVERY hop is re-validated by the SSRF guard —
  // an allowed host can otherwise 302 into a private/metadata address.
  let current = normalized;
  let response: Response | null = null;
  for (let hop = 0; hop < 5; hop += 1) {
    current = await assertPublicHttpUrl(current);
    response = await fetch(current, { redirect: 'manual' });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      current = new URL(response.headers.get('location') as string, current).toString();
      continue;
    }
    break;
  }
  if (!response) throw new Error(`Fetch failed for ${normalized}`);
  if (!response.ok) throw new Error(`Fetch failed (${response.status}) for ${current}`);
  // Reject early on the declared size before buffering the whole body.
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES) {
    throw new Error(`File is too large (${Math.round(declared / 1e6)} MB; max 25 MB).`);
  }
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(`File is too large (${Math.round(buffer.byteLength / 1e6)} MB; max 25 MB).`);
  }
  const contentType = response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
  const name = fallbackName || nameFromUrl(current) || 'download';
  return { bytes: buffer, contentType, name };
}

// Read an attachment off a synced email message: our encrypted storage first,
// else the provider, and a provider file is stored (mail-files.ts).
export async function fetchEmailAttachment(
  userId: string,
  accountRef: string,
  attachmentId: string,
  messageId: string,
  fallbackName?: string,
  deps = { readMailAttachmentBytes },
): Promise<FetchedBlob> {
  let file: Awaited<ReturnType<typeof readMailAttachmentBytes>>;
  try {
    file = await deps.readMailAttachmentBytes(
      { userId, account: accountRef, attachmentId, messageId },
      { fill: 'always', maxBytes: MAX_ATTACHMENT_BYTES },
    );
  } catch (error) {
    if (error instanceof AttachmentTooLargeError) throw new Error('Attachment is too large (max 25 MB).');
    throw error;
  }
  if (!file) throw new Error('Email account not connected, or attachment not found.');
  return {
    bytes: file.bytes,
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

// Retrieve a file uploaded in the current assistant turn so tools can attach
// chat-submitted files without refetching or asking the user to upload again.
export async function getStagedAgentUpload(
  userId: string,
  uploadId: string,
): Promise<StoredAttachment | null> {
  const row = await convexQuery<any | null>(agentUploadsApi.getUpload, { userId, uploadId });
  if (!row) return null;
  return {
    name: row.name,
    storageId: row.storageId,
    contentType: row.contentType,
    size: row.size,
  };
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
