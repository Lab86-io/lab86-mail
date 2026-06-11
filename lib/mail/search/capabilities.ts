import type { SearchExecutionTier, SearchProvider } from './ast';

// Local (Convex corpus) search is the primary tier for every provider. The
// fallback below only serves accounts whose corpus has not finished
// backfilling, or providers explicitly disabled via env.
const DEFAULT_LOCAL_PROVIDERS = new Set<SearchProvider>(['google', 'microsoft', 'icloud', 'imap']);

// Cursors returned by the local tier are tagged so paging stays on-tier
// instead of silently switching transports between pages.
export const LOCAL_PAGE_TOKEN_PREFIX = 'local:';

export interface SearchRouteInput {
  provider: SearchProvider;
  corpusReady: boolean;
  pageToken?: string;
  /** Oldest receivedAt the contiguous newest-first backfill has indexed, if any. */
  oldestIndexedAt?: number | null;
  /** The query's lower date bound (epoch ms), when it has one. */
  queryAfter?: number | null;
}

export interface SearchRoute {
  tier: SearchExecutionTier;
  provider: SearchProvider;
  reason: string;
  corpusReady: boolean;
  localEnabled: boolean;
}

export function fallbackTierForProvider(provider: SearchProvider): SearchExecutionTier {
  // Gmail's native query language is excellent and the user's typed query is
  // already in (a superset of) it, so Google falls back to a verbatim
  // search_query_native pass. Other providers fall back to Nylas structured
  // filters, which are lossy but correct.
  return provider === 'google' ? 'native' : 'structured';
}

export function isLocalPageToken(pageToken?: string) {
  return Boolean(pageToken?.startsWith(LOCAL_PAGE_TOKEN_PREFIX));
}

export function resolveSearchRoute(input: SearchRouteInput): SearchRoute {
  const localEnabled = isLocalSearchEnabledForProvider(input.provider);
  const fallback = fallbackTierForProvider(input.provider);
  const base = { provider: input.provider, corpusReady: input.corpusReady, localEnabled };

  if (input.pageToken && !isLocalPageToken(input.pageToken)) {
    return { ...base, tier: fallback, reason: 'continuing provider-cursor pagination' };
  }
  if (!localEnabled) {
    return { ...base, tier: fallback, reason: 'provider local search flag is disabled' };
  }
  if (!input.corpusReady) {
    // Backfill runs newest-first, so a partially-indexed corpus already holds
    // everything newer than oldestIndexedAt. A query bounded inside that
    // horizon (the default inbox view is newer_than:30d) can serve locally
    // long before the full-history backfill finishes.
    if (
      typeof input.oldestIndexedAt === 'number' &&
      typeof input.queryAfter === 'number' &&
      input.oldestIndexedAt <= input.queryAfter
    ) {
      return { ...base, tier: 'local', reason: 'partial corpus covers the queried window' };
    }
    return { ...base, tier: fallback, reason: 'corpus is not ready for this grant' };
  }
  return { ...base, tier: 'local', reason: 'corpus-ready local search enabled' };
}

export function isLocalSearchEnabledForProvider(provider: SearchProvider) {
  const disabled = providerSetFromEnv('LAB86_MAIL_LOCAL_SEARCH_DISABLED_PROVIDERS');
  if (disabled.has(provider) || disabled.has('all')) return false;

  const configured = process.env.LAB86_MAIL_LOCAL_SEARCH_PROVIDERS;
  if (configured !== undefined) {
    const enabled = providerSetFromEnv('LAB86_MAIL_LOCAL_SEARCH_PROVIDERS');
    return enabled.has(provider) || enabled.has('all');
  }

  const perProvider = process.env[`LAB86_MAIL_LOCAL_SEARCH_${provider.toUpperCase()}`];
  if (perProvider !== undefined) {
    const value = perProvider.trim().toLowerCase();
    return value === '1' || value === 'true';
  }

  return DEFAULT_LOCAL_PROVIDERS.has(provider);
}

function providerSetFromEnv(name: string) {
  return new Set(
    String(process.env[name] || '')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}
