import { z } from 'zod';
import type { ProductRelease } from './release';

export const RELEASE_RECEIPT_KEY = 'albatross:product-release:v1';
const LEGACY_SEEN_KEY = 'albatross:updates:last-seen';
const receiptSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  entryIds: z.array(z.string().min(1)).refine((ids) => new Set(ids).size === ids.length),
});

export type ReleaseReceipt = z.infer<typeof receiptSchema>;
export type ReceiptStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** Prefer the active tab's baseline, then the last acknowledged browser visit. */
export function releaseHistoryStores(): ReceiptStorage[] {
  const stores: ReceiptStorage[] = [];
  if (typeof window === 'undefined') return stores;
  for (const name of ['sessionStorage', 'localStorage'] as const) {
    try {
      stores.push(window[name]);
    } catch {
      // Storage restrictions must not disable the live update notice.
    }
  }
  return stores;
}

export function receiptForRelease(release: ProductRelease): ReleaseReceipt {
  return { schemaVersion: 1, id: release.id, entryIds: release.updates.map((update) => update.id) };
}

export function readReleaseHistory(stores: readonly ReceiptStorage[]): ReleaseReceipt | null {
  for (const storage of stores) {
    try {
      const parsed = receiptSchema.safeParse(JSON.parse(storage.getItem(RELEASE_RECEIPT_KEY) ?? 'null'));
      if (parsed.success) return parsed.data;
    } catch {
      // A damaged or unavailable store can fall back to the next one.
    }
  }
  return null;
}

export function writeReleaseHistory(stores: readonly ReceiptStorage[], receipt: ReleaseReceipt): void {
  for (const storage of stores) {
    try {
      storage.setItem(RELEASE_RECEIPT_KEY, JSON.stringify(receipt));
    } catch {
      // Another available store may still retain the acknowledgement.
    }
  }
}

/** Carry over readers of the former update page without replaying notes they already saw. */
function legacyReceipt(stores: readonly ReceiptStorage[], release: ProductRelease): ReleaseReceipt | null {
  for (const storage of stores) {
    try {
      const seenId = storage.getItem(LEGACY_SEEN_KEY);
      const index = release.updates.findIndex((update) => update.id === seenId);
      if (index >= 0) {
        return {
          schemaVersion: 1,
          id: `legacy:${seenId}`,
          entryIds: release.updates.slice(index).map((update) => update.id),
        };
      }
    } catch {
      // A blocked legacy store is equivalent to a first visit.
    }
  }
  return null;
}

/** First visits establish a baseline; changed builds retain the old receipt until dismissed. */
export function prepareReleaseArrival(
  release: ProductRelease,
  stores: readonly ReceiptStorage[],
): ReleaseReceipt | null {
  const previous = readReleaseHistory(stores) ?? legacyReceipt(stores, release);
  if (previous && previous.id !== release.id) {
    // Pin the old baseline to this tab without undoing another tab's acknowledgement.
    writeReleaseHistory(stores.slice(0, 1), previous);
    return previous;
  }
  writeReleaseHistory(stores, receiptForRelease(release));
  return null;
}
