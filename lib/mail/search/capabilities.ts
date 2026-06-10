import type { SearchExecutionTier, SearchProvider } from './ast';

const DEFAULT_LOCAL_PROVIDERS = new Set<SearchProvider>(['icloud', 'microsoft']);

export interface SearchRouteInput {
  provider: SearchProvider;
  corpusReady: boolean;
  hasPageToken?: boolean;
}

export interface SearchRoute {
  tier: SearchExecutionTier;
  provider: SearchProvider;
  reason: string;
  corpusReady: boolean;
  localEnabled: boolean;
}

export function resolveSearchRoute(input: SearchRouteInput): SearchRoute {
  const localEnabled = isLocalSearchEnabledForProvider(input.provider);
  if (input.hasPageToken) {
    return {
      tier: 'structured',
      provider: input.provider,
      reason: 'local search does not page through provider cursors',
      corpusReady: input.corpusReady,
      localEnabled,
    };
  }
  if (!localEnabled) {
    return {
      tier: 'structured',
      provider: input.provider,
      reason: 'provider local search flag is disabled',
      corpusReady: input.corpusReady,
      localEnabled,
    };
  }
  if (!input.corpusReady) {
    return {
      tier: 'structured',
      provider: input.provider,
      reason: 'corpus is not ready for this grant',
      corpusReady: false,
      localEnabled,
    };
  }
  return {
    tier: 'local',
    provider: input.provider,
    reason: 'corpus-ready local search enabled',
    corpusReady: true,
    localEnabled,
  };
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
  if (perProvider !== undefined) return perProvider === '1' || perProvider.toLowerCase() === 'true';

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
