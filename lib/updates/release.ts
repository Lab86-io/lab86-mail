import { z } from 'zod';
import { APP_VERSION } from '@/lib/version';
import { PRODUCT_UPDATES } from './feed';
import { type ProductUpdate, parseProductUpdates, productUpdateSchema } from './model';

const releaseSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  version: z.string().min(1),
  updates: z.array(productUpdateSchema),
});

export type ProductRelease = z.infer<typeof releaseSchema>;

// Both imports are bundled with this version of the app. A new note or version bump changes its identity.
export const CURRENT_PRODUCT_RELEASE: ProductRelease = {
  schemaVersion: 1,
  id: `${APP_VERSION}:${PRODUCT_UPDATES.map((update) => update.id).join(',')}`,
  version: APP_VERSION,
  updates: PRODUCT_UPDATES,
};

export function parseProductRelease(value: unknown): ProductRelease {
  const release = releaseSchema.parse(value);
  return { ...release, updates: parseProductUpdates(release.updates) };
}

export function newReleaseUpdates(release: ProductRelease, current: ProductRelease): ProductUpdate[] {
  const known = new Set(current.updates.map((update) => update.id));
  return release.updates.filter((update) => !known.has(update.id));
}

export async function fetchProductRelease(signal?: AbortSignal): Promise<ProductRelease> {
  const response = await fetch('/api/app-release', {
    credentials: 'same-origin',
    cache: 'no-store',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error('Could not check for updates.');
  return parseProductRelease(await response.json());
}
