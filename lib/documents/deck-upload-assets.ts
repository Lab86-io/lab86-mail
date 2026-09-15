import { api, convexQuery } from '@/lib/hosted/convex';
import { type DeckAsset, DeckAssetError, MAX_DECK_ASSET_BYTES, storeDeckAsset } from './deck-asset-store';
import type { CompositionAsset } from './presentation-compositions';

/**
 * The user's own images from chat uploads, turned into owned deck assets.
 * Each upload row is read for its owner only, its bytes are fetched from
 * storage within bounds, and `storeDeckAsset` checks the signature, size and
 * pixels before it records a `documentAssets` row. Files that are not images
 * are skipped with a plain note; nothing here fails the whole request.
 */

export const MAX_UPLOAD_ASSETS = 8;
const FETCH_TIMEOUT_MS = 30_000;
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);

interface UploadRow {
  _id: string;
  name: string;
  contentType?: string;
  size: number;
  url: string | null;
}

const defaultDependencies = {
  convexQuery,
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
  storeDeckAsset,
};
let dependencies = defaultDependencies;
export function __setDeckUploadAssetDepsForTest(overrides: Partial<typeof defaultDependencies> = {}) {
  dependencies = { ...defaultDependencies, ...overrides };
}

export interface UploadAssetsResult {
  assets: CompositionAsset[];
  /** One plain sentence per upload that was skipped. */
  notes: string[];
}

function isImageUpload(row: UploadRow) {
  if (row.contentType?.toLowerCase().startsWith('image/')) return true;
  const extension = row.name.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTENSIONS.has(extension);
}

/** "harbor-photo.jpg" becomes "harbor photo": the alt text when nothing better exists. */
export function altFromFileName(name: string) {
  return name
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function compositionAssetFromDeckAsset(asset: DeckAsset, alt: string): CompositionAsset {
  return { assetId: asset.assetId, src: asset.src, alt, aspect: asset.aspect };
}

async function readUploadBytes(url: string): Promise<Uint8Array> {
  const response = await dependencies.fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'error',
  });
  if (!response.ok) throw new DeckAssetError('The upload could not be read.', 502);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_DECK_ASSET_BYTES) throw new DeckAssetError('The image is larger than 8 MB.', 413);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_DECK_ASSET_BYTES)
    throw new DeckAssetError('The image is larger than 8 MB.', 413);
  return bytes;
}

/** Owned deck assets from the user's chat uploads, in the order given. */
export async function assetsFromUploads(userId: string, uploadIds: string[]): Promise<UploadAssetsResult> {
  const result: UploadAssetsResult = { assets: [], notes: [] };
  const ids = [...new Set(uploadIds.map((id) => id.trim()).filter(Boolean))].slice(0, MAX_UPLOAD_ASSETS);
  for (const uploadId of ids) {
    let row: UploadRow | null;
    try {
      row = await dependencies.convexQuery<UploadRow | null>((api as any).agentUploads.getUpload, {
        userId,
        uploadId,
      });
    } catch {
      row = null;
    }
    if (!row?.url) {
      result.notes.push('One attachment is no longer available and was skipped.');
      continue;
    }
    if (!isImageUpload(row)) {
      result.notes.push(`${row.name} is not an image and was skipped.`);
      continue;
    }
    if (row.size > MAX_DECK_ASSET_BYTES) {
      result.notes.push(`${row.name} is larger than 8 MB and was skipped.`);
      continue;
    }
    try {
      const bytes = await readUploadBytes(row.url);
      const stored = await dependencies.storeDeckAsset(userId, bytes);
      result.assets.push(compositionAssetFromDeckAsset(stored, altFromFileName(row.name) || 'image'));
    } catch (error) {
      const reason = error instanceof DeckAssetError ? error.message : 'The image could not be stored.';
      result.notes.push(`${row.name} was skipped. ${reason}`);
    }
  }
  return result;
}
