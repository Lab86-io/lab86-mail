import { z } from 'zod';
import { getPhotoFromCache, PHOTO_CACHE_VERSION, setPhotoCache } from '../store/photos';
import { companyLogoCandidates, companyLogoUrl, resolveProviderProfilePhoto } from './photo-resolution';
import { defineTool } from './registry';

const PROVIDER_LOOKUP_CAP = 24;
const PROVIDER_LOOKUP_BUDGET_MS = 5_000;
const PROVIDER_LOOKUP_TIMEOUT_MS = 900;

type TimeoutResult<T> =
  | { status: 'resolved'; value: T }
  | { status: 'rejected'; value: T }
  | { status: 'timeout'; value: T };

interface PhotoToolDeps {
  getPhotoFromCache: typeof getPhotoFromCache;
  setPhotoCache: typeof setPhotoCache;
  companyLogoUrl: typeof companyLogoUrl;
  companyLogoCandidates: typeof companyLogoCandidates;
  resolveProviderProfilePhoto: typeof resolveProviderProfilePhoto;
  now: () => number;
  providerLookupTimeoutMs: number;
}

const defaultDeps: PhotoToolDeps = {
  getPhotoFromCache,
  setPhotoCache,
  companyLogoUrl,
  companyLogoCandidates,
  resolveProviderProfilePhoto,
  now: () => Date.now(),
  providerLookupTimeoutMs: PROVIDER_LOOKUP_TIMEOUT_MS,
};

let deps = defaultDeps;

export function setPhotoToolDependenciesForTest(overrides: Partial<PhotoToolDeps>) {
  deps = { ...defaultDeps, ...overrides };
  return () => {
    deps = defaultDeps;
  };
}

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
    const providerStartedAt = deps.now();
    let providerLookups = 0;

    for (const raw of emails) {
      const email = (raw || '').trim().toLowerCase();
      if (!email || seen.has(email)) continue;
      seen.add(email);

      const cached = await deps.getPhotoFromCache(email).catch(() => null);
      const logoUrl =
        cached?.url && cached.version === PHOTO_CACHE_VERSION && cached.source === 'company'
          ? cached.url
          : deps.companyLogoUrl(email);
      if (
        cached?.url &&
        cached.version === PHOTO_CACHE_VERSION &&
        cached.source !== 'provider' &&
        cached.source !== 'company'
      ) {
        out[email] = cached.url;
        continue;
      }

      const freshMiss = cached?.version === PHOTO_CACHE_VERSION && cached.source === 'none' && !logoUrl;
      if (freshMiss) {
        out[email] = null;
        continue;
      }

      const canLookupProvider =
        providerLookups < PROVIDER_LOOKUP_CAP && deps.now() - providerStartedAt < PROVIDER_LOOKUP_BUDGET_MS;
      if (!canLookupProvider) {
        out[email] = logoUrl || null;
        if (logoUrl) await deps.setPhotoCache(email, logoUrl, 'company').catch(() => undefined);
        continue;
      }

      providerLookups += 1;
      const provider = await withTimeoutResult(
        deps.resolveProviderProfilePhoto({
          userId: ctx.userId,
          account,
          email,
        }),
        deps.providerLookupTimeoutMs,
        null,
      );
      if (provider.status === 'resolved' && provider.value) {
        out[email] = provider.value;
        continue;
      }
      if (logoUrl) {
        out[email] = logoUrl;
        await deps.setPhotoCache(email, logoUrl, 'company').catch(() => undefined);
        continue;
      }
      out[email] = null;
      if (provider.status === 'resolved')
        await deps.setPhotoCache(email, null, 'none').catch(() => undefined);
    }

    return { photos: out };
  },
});

export function logoCandidatesForEmail(email: string): string[] {
  return deps.companyLogoCandidates(email);
}

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

export function withTimeoutResult<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T,
): Promise<TimeoutResult<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ status: 'timeout', value: fallback });
    }, timeoutMs);
    promise
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ status: 'resolved', value });
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ status: 'rejected', value: fallback });
      });
  });
}
