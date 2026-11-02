// One slim latest edition in localStorage, so a reload paints the brief at once
// and the network read then replaces it. The key has the `lab86-` prefix, so
// sign-out removes it (lib/auth/sign-out-storage.ts). The record names its owner,
// so another user on this browser never reads it. It holds the edition only: no
// other store, no job state, and no one-time code.

import type { QueryClient } from '@tanstack/react-query';
import { isAppSignOutInProgress } from '../auth/sign-out-storage';
import type { BriefViewResponse, BriefWebEdition } from './web-view';

export const BRIEF_EDITION_CACHE_KEY = 'lab86-brief-latest-v1';
/** The stamp of a cached read. It never equals a live stamp, so the head always checks it. */
export const BRIEF_CACHED_STAMP = 'cached';
const BRIEF_LATEST_QUERY_KEY = ['daily-report', 'latest'];
// A larger edition is not worth the synchronous parse on each load.
const MAX_CACHE_BYTES = 512_000;
const MAX_CACHE_AGE_MS = 7 * 24 * 3_600_000;

type CacheStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

interface EditionCacheRecord {
  owner: string;
  savedAt: number;
  revision: string | null;
  report: BriefWebEdition;
}

function browserStorage(): CacheStorage | null {
  // Safari private mode and blocked storage throw on access.
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

// The stored Needs you region has no codes (lib/obligations/brief-region.ts).
// This line stops one from reaching the browser's disk if that ever changes.
function withoutCodes(report: BriefWebEdition): BriefWebEdition {
  const region = report.sections.needsYou as { items?: Array<Record<string, unknown>> } | undefined;
  if (!Array.isArray(region?.items)) return report;
  const items = region.items.filter((item) => item?.kind !== 'code').map(({ code: _code, ...item }) => item);
  return { ...report, sections: { ...report.sections, needsYou: { ...region, items } } };
}

/** Reads the record of this owner. Another owner's record or an old record goes away. */
export function readBriefEditionCache(
  owner: string,
  storage: CacheStorage | null = browserStorage(),
  now = Date.now(),
): EditionCacheRecord | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(BRIEF_EDITION_CACHE_KEY);
    if (!raw) return null;
    const record = JSON.parse(raw) as Partial<EditionCacheRecord>;
    const valid =
      record.owner === owner &&
      typeof record.savedAt === 'number' &&
      now - record.savedAt <= MAX_CACHE_AGE_MS &&
      record.report &&
      typeof record.report._id === 'string' &&
      record.report.sections;
    if (valid) return record as EditionCacheRecord;
    storage.removeItem(BRIEF_EDITION_CACHE_KEY);
  } catch {
    try {
      storage.removeItem(BRIEF_EDITION_CACHE_KEY);
    } catch {
      // Blocked storage has nothing to clean.
    }
  }
  return null;
}

/** Saves the latest edition. A pending edition, a model-written page, or an oversized edition stays out. */
export function writeBriefEditionCache(
  owner: string,
  view: Pick<BriefViewResponse, 'report' | 'revision' | 'pending'>,
  storage: CacheStorage | null = browserStorage(),
  now = Date.now(),
): boolean {
  if (!storage || isAppSignOutInProgress()) return false;
  try {
    if (view.report === null) {
      storage.removeItem(BRIEF_EDITION_CACHE_KEY);
      return false;
    }
    if (!view.report || view.pending || view.report.html) return false;
    const record: EditionCacheRecord = {
      owner,
      savedAt: now,
      revision: view.revision ?? null,
      report: withoutCodes(view.report),
    };
    const raw = JSON.stringify(record);
    if (raw.length > MAX_CACHE_BYTES) {
      storage.removeItem(BRIEF_EDITION_CACHE_KEY);
      return false;
    }
    storage.setItem(BRIEF_EDITION_CACHE_KEY, raw);
    return true;
  } catch {
    // A full disk costs only the fast first paint.
    return false;
  }
}

/**
 * Connects the cache to the query client for one signed-in user: it fills the
 * empty latest query from disk, then saves each new latest edition. The saved
 * time is the query's age, so the page still reads the network on mount.
 */
export function bindBriefEditionCache(
  client: QueryClient,
  owner: string,
  storage: CacheStorage | null = browserStorage(),
): () => void {
  let written: string | null = null;
  if (!client.getQueryData(BRIEF_LATEST_QUERY_KEY)) {
    const record = readBriefEditionCache(owner, storage);
    if (record) {
      written = record.revision;
      client.setQueryData<BriefViewResponse>(
        BRIEF_LATEST_QUERY_KEY,
        { stamp: BRIEF_CACHED_STAMP, pending: null, revision: record.revision, report: record.report },
        { updatedAt: record.savedAt },
      );
    }
  }
  return client.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'success') return;
    const key = event.query.queryKey;
    if (key[0] !== BRIEF_LATEST_QUERY_KEY[0] || key[1] !== BRIEF_LATEST_QUERY_KEY[1]) return;
    const view = event.query.state.data as BriefViewResponse | undefined;
    if (!view || (view.revision && view.revision === written)) return;
    if (writeBriefEditionCache(owner, view, storage)) written = view.revision ?? null;
  });
}
