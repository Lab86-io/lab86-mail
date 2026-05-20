import { db, findOne, upsert } from './db';

export interface PhotoCacheEntry {
  email: string;
  url: string | null;
  at: number;
}

// 7-day TTL. Negative results (no photo found) are cached too so we don't
// re-hit gog/People for the long tail of non-contacts on every load.
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function getPhotoFromCache(email: string): Promise<PhotoCacheEntry | null> {
  const key = email.toLowerCase();
  const entry = await findOne<PhotoCacheEntry>(db().photos, { email: key });
  if (!entry) return null;
  if (Date.now() - (entry.at || 0) > TTL_MS) return null;
  return entry;
}

export async function setPhotoCache(email: string, url: string | null): Promise<void> {
  const key = email.toLowerCase();
  await upsert<PhotoCacheEntry>(db().photos, { email: key }, { email: key, url, at: Date.now() });
}
