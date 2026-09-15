import { createHash } from 'node:crypto';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';

/**
 * Owned images for presentations. Bytes are checked by signature, bounded in
 * size and pixels, hashed, stored in Convex storage and recorded per owner.
 * The returned `src` is the stable storage URL a deck keeps beside `assetId`.
 */

export const MAX_DECK_ASSET_BYTES = 8 * 1024 * 1024;
export const MAX_DECK_ASSET_PIXELS = 8_000;

export class DeckAssetError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'DeckAssetError';
    this.status = status;
  }
}

export interface DeckAsset {
  assetId: string;
  src: string;
  width: number;
  height: number;
  aspect: number;
  mime: string;
  size: number;
}

/** Image type from the file signature, never from the declared content type. */
export function sniffImageMime(
  bytes: Uint8Array,
): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return 'image/webp';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
  return null;
}

async function measure(bytes: Uint8Array): Promise<{ width: number; height: number }> {
  const { loadImage } = await import('@napi-rs/canvas');
  const image = await loadImage(Buffer.from(bytes));
  return { width: image.width, height: image.height };
}

const defaultDependencies = {
  convexMutation,
  convexQuery,
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
  measure,
};
let dependencies = defaultDependencies;
export function __setDeckAssetDepsForTest(overrides: Partial<typeof defaultDependencies> = {}) {
  dependencies = { ...defaultDependencies, ...overrides };
}

const assets = () => (api as any).documentAssets;

function toAsset(row: {
  assetId: string;
  url: string | null;
  width: number;
  height: number;
  mime: string;
  size: number;
}): DeckAsset {
  if (!row.url) throw new DeckAssetError('The image is stored but has no readable address.', 502);
  return {
    assetId: String(row.assetId),
    src: row.url,
    width: row.width,
    height: row.height,
    aspect: row.height ? Math.round((row.width / row.height) * 1000) / 1000 : 1,
    mime: row.mime,
    size: row.size,
  };
}

export async function storeDeckAsset(userId: string, bytes: Uint8Array): Promise<DeckAsset> {
  if (!bytes.length) throw new DeckAssetError('The upload is empty.');
  if (bytes.length > MAX_DECK_ASSET_BYTES)
    throw new DeckAssetError(
      `Images must be ${Math.round(MAX_DECK_ASSET_BYTES / 1024 / 1024)} MB or smaller.`,
      413,
    );
  const mime = sniffImageMime(bytes);
  if (!mime) throw new DeckAssetError('Use a PNG, JPEG, WebP or GIF image.', 415);
  let size: { width: number; height: number };
  try {
    size = await dependencies.measure(bytes);
  } catch {
    throw new DeckAssetError('The image could not be read.', 415);
  }
  if (!size.width || !size.height) throw new DeckAssetError('The image has no size.', 415);
  if (size.width > MAX_DECK_ASSET_PIXELS || size.height > MAX_DECK_ASSET_PIXELS)
    throw new DeckAssetError(`Images must be ${MAX_DECK_ASSET_PIXELS} pixels or smaller on each side.`, 413);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const uploadUrl = await dependencies.convexMutation<string>(assets().uploadUrl, { userId });
  const response = await dependencies.fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': mime },
    body: new Uint8Array(bytes),
    signal: AbortSignal.timeout(45_000),
    redirect: 'error',
  });
  if (!response.ok) throw new DeckAssetError('The image could not be stored. Try again.', 502);
  const stored = (await response.json()) as { storageId?: string };
  if (!stored.storageId) throw new DeckAssetError('Storage did not confirm the image.', 502);
  const row = await dependencies.convexMutation<Parameters<typeof toAsset>[0]>(assets().create, {
    userId,
    storageId: stored.storageId,
    mime,
    size: bytes.length,
    width: size.width,
    height: size.height,
    sha256,
  });
  return toAsset(row);
}

export async function getDeckAsset(userId: string, assetId: string): Promise<DeckAsset | null> {
  const row = await dependencies.convexQuery<Parameters<typeof toAsset>[0] | null>(assets().get, {
    userId,
    assetId,
  });
  return row ? toAsset(row) : null;
}
