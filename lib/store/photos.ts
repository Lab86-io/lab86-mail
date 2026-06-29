import { kvGet, kvUpsert } from './kv';

export interface PhotoCacheEntry {
  email: string;
  url: string | null;
  at: number;
  source?: 'provider' | 'company' | 'company-provider-miss' | 'none';
  version?: number;
}

export const PHOTO_CACHE_VERSION = 2;

// 7-day TTL. Negative results (no photo found) are cached too, so the UI does
// not keep retrying missing profile photos.
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function getPhotoFromCache(email: string): Promise<PhotoCacheEntry | null> {
  const key = email.toLowerCase();
  const entry = await kvGet<PhotoCacheEntry>('photo', key);
  if (!entry) return null;
  if (Date.now() - (entry.at || 0) > TTL_MS) return null;
  return entry;
}

export async function setPhotoCache(
  email: string,
  url: string | null,
  source: PhotoCacheEntry['source'] = url ? 'provider' : 'none',
): Promise<void> {
  const key = email.toLowerCase();
  await kvUpsert('photo', key, { email: key, url, source, version: PHOTO_CACHE_VERSION, at: Date.now() });
}
