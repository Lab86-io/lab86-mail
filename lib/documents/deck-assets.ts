import { readFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_ASSET_BYTES = 12 * 1024 * 1024;
const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

/** Hosts that hold assets a deck may own. Anything else is refused, never fetched. */
function allowedAssetHost(host: string) {
  const convex = process.env.NEXT_PUBLIC_CONVEX_URL ? new URL(process.env.NEXT_PUBLIC_CONVEX_URL).host : '';
  return host === convex || host.endsWith('.convex.cloud') || host.endsWith('.convex.site');
}

export interface LoadedDeckAsset {
  /** pptxgenjs data URI form: `image/png;base64,...` */
  data: string;
  mime: string;
  bytes: number;
}

/**
 * Read an owned deck asset for export. Relative paths resolve under `public`;
 * absolute URLs must point at owned storage. Size and time are bounded.
 */
export async function loadDeckAsset(src: string): Promise<LoadedDeckAsset> {
  if (src.startsWith('/') && !src.startsWith('//')) {
    const publicDir = path.resolve(process.cwd(), 'public');
    const target = path.resolve(publicDir, `.${src.split('?')[0]}`);
    if (!target.startsWith(`${publicDir}${path.sep}`))
      throw new Error('Asset path escapes the public directory.');
    const buffer = await readFile(target);
    if (buffer.byteLength > MAX_ASSET_BYTES) throw new Error('Asset is too large to export.');
    const mime = MIME_BY_EXTENSION[path.extname(target).toLowerCase()] || 'image/png';
    return { data: `${mime};base64,${buffer.toString('base64')}`, mime, bytes: buffer.byteLength };
  }
  const url = new URL(src);
  if (url.protocol !== 'https:' || !allowedAssetHost(url.host))
    throw new Error('Asset must live in owned storage.');
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: 'error' });
  if (!response.ok) throw new Error(`Asset fetch failed (${response.status}).`);
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_ASSET_BYTES) throw new Error('Asset is too large to export.');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_ASSET_BYTES) throw new Error('Asset is too large to export.');
  const mime = (response.headers.get('content-type') || '').split(';')[0].trim() || 'image/png';
  if (!mime.startsWith('image/')) throw new Error('Asset is not an image.');
  return { data: `${mime};base64,${buffer.toString('base64')}`, mime, bytes: buffer.byteLength };
}
