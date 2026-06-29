import { z } from 'zod';
import { getPhotoFromCache, PHOTO_CACHE_VERSION, setPhotoCache } from '../store/photos';
import { companyLogoUrl, resolveProviderProfilePhoto } from './photo-resolution';
import { defineTool } from './registry';

const PROVIDER_LOOKUP_CAP = 24;
const PROVIDER_LOOKUP_BUDGET_MS = 5_000;
const PROVIDER_LOOKUP_TIMEOUT_MS = 900;

export const resolvePhotos = defineTool({
  name: 'resolve_photos',
  description: 'Resolve cached profile photo URLs for a batch of email addresses.',
  category: 'contacts',
  mutating: false,
  input: z.object({
    account: z.string(),
    emails: z.array(z.string()).max(200),
  }),
  output: z.object({ photos: z.record(z.string(), z.string().nullable()) }),
  async handler({ account, emails }, ctx) {
    const out: Record<string, string | null> = {};
    const seen = new Set<string>();
    const providerStartedAt = Date.now();
    let providerLookups = 0;

    for (const raw of emails) {
      const email = (raw || '').trim().toLowerCase();
      if (!email || seen.has(email)) continue;
      seen.add(email);

      const logoUrl = companyLogoUrl(email);
      const cached = await getPhotoFromCache(email).catch(() => null);
      if (cached?.url && cached.version === PHOTO_CACHE_VERSION && cached.source !== 'provider') {
        out[email] = cached.url;
        continue;
      }

      if (logoUrl) {
        out[email] = logoUrl;
        await setPhotoCache(email, logoUrl, 'company').catch(() => undefined);
        continue;
      }

      const freshMiss = cached?.version === PHOTO_CACHE_VERSION && cached.source === 'none' && !logoUrl;
      if (freshMiss) {
        out[email] = null;
        continue;
      }

      const canLookupProvider =
        providerLookups < PROVIDER_LOOKUP_CAP && Date.now() - providerStartedAt < PROVIDER_LOOKUP_BUDGET_MS;
      if (!canLookupProvider) {
        out[email] = null;
        continue;
      }

      providerLookups += 1;
      const providerUrl = await withTimeout(
        resolveProviderProfilePhoto({
          userId: ctx.userId,
          account,
          email,
        }).catch(() => null),
        PROVIDER_LOOKUP_TIMEOUT_MS,
        null,
      );
      out[email] = providerUrl;
      if (!providerUrl) await setPhotoCache(email, null, 'none').catch(() => undefined);
    }

    return { photos: out };
  },
});

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, timeoutMs);
    promise
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(fallback);
      });
  });
}
