// Structured model catalog for the AI picker and the runtime.
//
// The catalog merges a curated table (known families, tiers, notes, direct
// ids) with the live OpenRouter /api/v1/models response (context, pricing,
// release date, capabilities). The merge also decides status: a family member
// with a newer current version is 'legacy'; a curated id that the live list no
// longer carries is 'deprecated' and points at a replacement; a model that a
// direct OpenAI or Anthropic key cannot serve is 'unavailable'.
//
// Pure functions only (no env, no fetch) except `loadModelCatalog`, which
// reuses the cached live fetch from model-options.

import {
  fetchOpenRouterCatalog,
  isOpenRouterModelId,
  OPENROUTER_DEFAULT_FAST_MODEL,
  OPENROUTER_DEFAULT_PRIMARY_MODEL,
  type Provider,
} from './model-options';

export type CatalogProvider =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'xai'
  | 'deepseek'
  | 'moonshotai'
  | 'qwen'
  | 'meta'
  | 'mistral'
  | 'other';

export type CatalogTier = 'flagship' | 'balanced' | 'fast' | 'nano';
export type CatalogStatus = 'current' | 'legacy' | 'deprecated' | 'unavailable';
export type CatalogSlot = 'normal' | 'fast';

export type CatalogCapabilities = {
  reasoning: boolean;
  tools: boolean;
  vision: boolean;
  pdf: boolean;
  longContext: boolean;
};

export type CatalogPricing = { inputPerM: number; outputPerM: number };

export type CatalogModel = {
  /** Canonical vendor-prefixed id, e.g. 'openai/gpt-5.5'. */
  id: string;
  /** Id the vendor's own API accepts, e.g. 'gpt-5.5' or 'claude-sonnet-4-6'. */
  directId: string;
  provider: CatalogProvider;
  providerLabel: string;
  name: string;
  family: string;
  version: string;
  tier: CatalogTier;
  capabilities: CatalogCapabilities;
  contextTokens: number | null;
  pricing: CatalogPricing | null;
  releasedAt: string | null;
  status: CatalogStatus;
  catalogStatus?: Exclude<CatalogStatus, 'unavailable'>;
  /** Set when status is 'deprecated'. */
  replacementId?: string;
  recommendedFor: CatalogSlot[];
  note: string;
};

export type OpenRouterLiveModel = {
  id?: string;
  name?: string;
  created?: number;
  context_length?: number;
  pricing?: { prompt?: string | number; completion?: string | number };
  supported_parameters?: string[];
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
};

export const PROVIDER_ORDER: CatalogProvider[] = [
  'openai',
  'anthropic',
  'google',
  'xai',
  'deepseek',
  'moonshotai',
  'qwen',
  'meta',
  'mistral',
  'other',
];

export const PROVIDER_LABELS: Record<CatalogProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  xai: 'xAI',
  deepseek: 'DeepSeek',
  moonshotai: 'Moonshot',
  qwen: 'Qwen',
  meta: 'Meta',
  mistral: 'Mistral',
  other: 'Other',
};

export const TIER_LABELS: Record<CatalogTier, string> = {
  flagship: 'Flagship',
  balanced: 'Balanced',
  fast: 'Fast',
  nano: 'Nano',
};

const FAST_TIERS = new Set<CatalogTier>(['fast', 'nano']);
const LONG_CONTEXT_TOKENS = 400_000;
// Platform defaults stay 'current' even when a newer family member exists:
// the default is the product's choice, and a picker that marks its own
// default as older reads as broken.
const PINNED_IDS = new Set([OPENROUTER_DEFAULT_PRIMARY_MODEL, OPENROUTER_DEFAULT_FAST_MODEL]);

type CuratedModel = {
  id: string;
  directId?: string;
  name: string;
  family: string;
  version: string;
  tier: CatalogTier;
  recommendedFor: CatalogSlot[];
  note: string;
  /** Fallbacks when the live catalog is not reachable. */
  contextTokens?: number;
  pricing?: CatalogPricing;
  releasedAt?: string;
  capabilities?: Partial<CatalogCapabilities>;
  /** Curated retirement: the id is gone from every provider. */
  deprecated?: { replacementId: string };
};

// Verified against the live OpenRouter catalog on 2026-09-11. Pricing is USD
// per million tokens. Context values are the OpenRouter context_length.
const CURATED: CuratedModel[] = [
  // OpenAI
  {
    id: 'openai/gpt-5.5',
    name: 'GPT-5.5',
    family: 'gpt',
    version: '5.5',
    tier: 'flagship',
    recommendedFor: ['normal'],
    note: 'Default for deep mail work, planning, and drafts.',
    contextTokens: 1_050_000,
    pricing: { inputPerM: 5, outputPerM: 30 },
    releasedAt: '2026-04-24',
    capabilities: { reasoning: true, tools: true, vision: true, pdf: true },
  },
  {
    id: 'openai/gpt-5.4',
    name: 'GPT-5.4',
    family: 'gpt',
    version: '5.4',
    tier: 'balanced',
    recommendedFor: ['normal'],
    note: 'Previous OpenAI flagship at half the price of GPT-5.5.',
    contextTokens: 1_050_000,
    pricing: { inputPerM: 2.5, outputPerM: 15 },
    releasedAt: '2026-03-05',
    capabilities: { reasoning: true, tools: true, vision: true, pdf: true },
  },
  {
    id: 'openai/gpt-5.4-mini',
    name: 'GPT-5.4 Mini',
    family: 'gpt-mini',
    version: '5.4',
    tier: 'fast',
    recommendedFor: ['fast'],
    note: 'Heavier than nano, still quick for summaries and labels.',
    contextTokens: 400_000,
    pricing: { inputPerM: 0.75, outputPerM: 4.5 },
    releasedAt: '2026-03-17',
    capabilities: { reasoning: true, tools: true, vision: true, pdf: true },
  },
  {
    id: 'openai/gpt-5-nano',
    name: 'GPT-5 Nano',
    family: 'gpt-nano',
    version: '5.0',
    tier: 'nano',
    recommendedFor: ['fast'],
    note: 'Default fast model. The cheapest path for summaries and quick drafts.',
    contextTokens: 400_000,
    pricing: { inputPerM: 0.05, outputPerM: 0.4 },
    releasedAt: '2025-08-07',
    capabilities: { reasoning: true, tools: true, vision: true, pdf: true },
  },
  {
    id: 'openai/gpt-5.4-nano',
    name: 'GPT-5.4 Nano',
    family: 'gpt-nano',
    version: '5.4',
    tier: 'nano',
    recommendedFor: ['fast'],
    note: 'Newer nano with better instruction following at four times the price.',
    contextTokens: 400_000,
    pricing: { inputPerM: 0.2, outputPerM: 1.25 },
    releasedAt: '2026-03-17',
    capabilities: { reasoning: true, tools: true, vision: true, pdf: true },
  },
  {
    id: 'openai/gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
    family: 'gpt-luna',
    version: '5.6',
    tier: 'nano',
    recommendedFor: ['fast'],
    note: 'Small high-volume model for classification and extraction.',
    contextTokens: 1_050_000,
    pricing: { inputPerM: 0.2, outputPerM: 1.2 },
    releasedAt: '2026-07-09',
    capabilities: { reasoning: true, tools: true, vision: true, pdf: true },
  },
  {
    id: 'openai/gpt-5.1-chat',
    name: 'GPT-5.1 Chat',
    family: 'gpt-chat',
    version: '5.1',
    tier: 'balanced',
    recommendedFor: [],
    note: 'Retired by OpenRouter. Use GPT-5.5.',
    contextTokens: 128_000,
    deprecated: { replacementId: 'openai/gpt-5.5' },
    capabilities: { reasoning: false, tools: true, vision: true, pdf: false },
  },
  // Anthropic (direct ids use dashes, not dots)
  {
    id: 'anthropic/claude-opus-4.8',
    directId: 'claude-opus-4-8',
    name: 'Claude Opus 4.8',
    family: 'claude-opus',
    version: '4.8',
    tier: 'flagship',
    recommendedFor: ['normal'],
    note: 'Strongest Anthropic model for long, careful work.',
    contextTokens: 1_000_000,
    pricing: { inputPerM: 5, outputPerM: 25 },
    releasedAt: '2026-05-27',
    capabilities: { reasoning: true, tools: true, vision: true, pdf: true },
  },
  {
    id: 'anthropic/claude-sonnet-4.6',
    directId: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    family: 'claude-sonnet',
    version: '4.6',
    tier: 'balanced',
    recommendedFor: ['normal'],
    note: 'Long-context analysis and careful writing at a mid price.',
    contextTokens: 1_000_000,
    pricing: { inputPerM: 3, outputPerM: 15 },
    releasedAt: '2026-02-17',
    capabilities: { reasoning: true, tools: true, vision: true, pdf: true },
  },
  {
    id: 'anthropic/claude-haiku-4.5',
    directId: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    family: 'claude-haiku',
    version: '4.5',
    tier: 'fast',
    recommendedFor: ['fast'],
    note: 'Low-latency Anthropic model for light mail tasks.',
    contextTokens: 200_000,
    pricing: { inputPerM: 1, outputPerM: 5 },
    releasedAt: '2025-10-15',
    capabilities: { reasoning: true, tools: true, vision: true, pdf: true },
  },
  // Google
  {
    id: 'google/gemini-3.1-pro-preview',
    name: 'Gemini 3.1 Pro',
    family: 'gemini-pro',
    version: '3.1',
    tier: 'flagship',
    recommendedFor: ['normal'],
    note: 'Preview id on OpenRouter. Strong on long documents.',
    contextTokens: 1_048_576,
    pricing: { inputPerM: 2, outputPerM: 12 },
    releasedAt: '2026-02-19',
    capabilities: { reasoning: true, tools: true, vision: true, pdf: true },
  },
  {
    id: 'google/gemini-3.5-flash',
    name: 'Gemini 3.5 Flash',
    family: 'gemini-flash',
    version: '3.5',
    tier: 'balanced',
    recommendedFor: ['normal'],
    note: 'Large context with balanced latency and cost.',
    contextTokens: 1_048_576,
    pricing: { inputPerM: 1.5, outputPerM: 9 },
    releasedAt: '2026-05-19',
    capabilities: { reasoning: true, tools: true, vision: true, pdf: true },
  },
  {
    id: 'google/gemini-3.5-flash-lite',
    name: 'Gemini 3.5 Flash Lite',
    family: 'gemini-flash-lite',
    version: '3.5',
    tier: 'fast',
    recommendedFor: ['fast'],
    note: 'Large-context fast path with low cost.',
    contextTokens: 1_048_576,
    pricing: { inputPerM: 0.3, outputPerM: 2.5 },
    releasedAt: '2026-07-21',
    capabilities: { reasoning: true, tools: true, vision: true, pdf: true },
  },
  {
    id: 'google/gemini-3.1-flash-lite',
    name: 'Gemini 3.1 Flash Lite',
    family: 'gemini-flash-lite',
    version: '3.1',
    tier: 'fast',
    recommendedFor: ['fast'],
    note: 'Older Flash Lite. Gemini 3.5 Flash Lite replaces it.',
    contextTokens: 1_048_576,
    pricing: { inputPerM: 0.25, outputPerM: 1.5 },
    releasedAt: '2026-05-07',
    capabilities: { reasoning: true, tools: true, vision: true, pdf: true },
  },
  // xAI
  {
    id: 'x-ai/grok-4.3',
    name: 'Grok 4.3',
    family: 'grok',
    version: '4.3',
    tier: 'flagship',
    recommendedFor: ['normal'],
    note: 'High-context general reasoning at a low price.',
    contextTokens: 1_000_000,
    pricing: { inputPerM: 1.25, outputPerM: 2.5 },
    releasedAt: '2026-04-30',
    capabilities: { reasoning: true, tools: true, vision: true, pdf: true },
  },
  // DeepSeek
  {
    id: 'deepseek/deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    family: 'deepseek-pro',
    version: '4',
    tier: 'balanced',
    recommendedFor: ['normal'],
    note: 'Heavier analysis at OpenRouter pricing. Text only.',
    contextTokens: 1_048_576,
    pricing: { inputPerM: 0.96, outputPerM: 1.91 },
    releasedAt: '2026-04-24',
    capabilities: { reasoning: true, tools: true, vision: false, pdf: false },
  },
  {
    id: 'deepseek/deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    family: 'deepseek-flash',
    version: '4',
    tier: 'fast',
    recommendedFor: ['fast'],
    note: 'Quick classification and extraction. Text only.',
    contextTokens: 1_048_576,
    pricing: { inputPerM: 0.09, outputPerM: 0.18 },
    releasedAt: '2026-04-24',
    capabilities: { reasoning: true, tools: true, vision: false, pdf: false },
  },
  // Moonshot
  {
    id: 'moonshotai/kimi-k2.6',
    name: 'Kimi K2.6',
    family: 'kimi',
    version: '2.6',
    tier: 'balanced',
    recommendedFor: ['normal'],
    note: 'Long-context reasoning model from Moonshot AI.',
    contextTokens: 262_144,
    pricing: { inputPerM: 0.95, outputPerM: 4 },
    releasedAt: '2026-04-20',
    capabilities: { reasoning: true, tools: true, vision: true, pdf: false },
  },
  // Qwen
  {
    id: 'qwen/qwen3.6-plus',
    name: 'Qwen3.6 Plus',
    family: 'qwen-plus',
    version: '3.6',
    tier: 'balanced',
    recommendedFor: ['normal'],
    note: 'General Qwen model with a 1M context.',
    contextTokens: 1_000_000,
    pricing: { inputPerM: 0.33, outputPerM: 1.95 },
    releasedAt: '2026-04-02',
    capabilities: { reasoning: true, tools: true, vision: true, pdf: false },
  },
  {
    id: 'qwen/qwen3-coder',
    name: 'Qwen3 Coder',
    family: 'qwen-coder',
    version: '3',
    tier: 'balanced',
    recommendedFor: ['normal'],
    note: 'Technical mail, code, and structured agent tasks.',
    contextTokens: 262_144,
    pricing: { inputPerM: 0.3, outputPerM: 1 },
    releasedAt: '2025-07-23',
    capabilities: { reasoning: false, tools: true, vision: false, pdf: false },
  },
  {
    id: 'qwen/qwen3.6-flash',
    name: 'Qwen3.6 Flash',
    family: 'qwen-flash',
    version: '3.6',
    tier: 'fast',
    recommendedFor: ['fast'],
    note: 'Fast Qwen model with a 1M context.',
    contextTokens: 1_000_000,
    pricing: { inputPerM: 0.19, outputPerM: 1.13 },
    releasedAt: '2026-04-27',
    capabilities: { reasoning: true, tools: true, vision: true, pdf: false },
  },
  // Meta
  {
    id: 'meta-llama/llama-4-maverick',
    name: 'Llama 4 Maverick',
    family: 'llama-maverick',
    version: '4',
    tier: 'balanced',
    recommendedFor: ['normal'],
    note: 'Open-weight Meta model with a 1M context.',
    contextTokens: 1_048_576,
    pricing: { inputPerM: 0.2, outputPerM: 0.7 },
    releasedAt: '2025-04-05',
    capabilities: { reasoning: false, tools: true, vision: true, pdf: false },
  },
  {
    id: 'meta-llama/llama-4-scout',
    name: 'Llama 4 Scout',
    family: 'llama-scout',
    version: '4',
    tier: 'fast',
    recommendedFor: ['fast'],
    note: 'Small open-weight Meta model for quick tasks.',
    contextTokens: 1_310_720,
    pricing: { inputPerM: 0.1, outputPerM: 0.3 },
    releasedAt: '2025-04-05',
    capabilities: { reasoning: false, tools: true, vision: true, pdf: false },
  },
];

const PROVIDER_BY_PREFIX: Record<string, CatalogProvider> = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  'x-ai': 'xai',
  deepseek: 'deepseek',
  moonshotai: 'moonshotai',
  qwen: 'qwen',
  'meta-llama': 'meta',
  mistralai: 'mistral',
};

/** Vendor for a canonical or direct model id. */
export function providerForModelId(id: string): CatalogProvider {
  const value = (id || '').toLowerCase().trim();
  const slash = value.indexOf('/');
  if (slash > 0) return PROVIDER_BY_PREFIX[value.slice(0, slash)] || 'other';
  if (value.startsWith('claude')) return 'anthropic';
  if (/^(gpt[-\d]|o\d|chatgpt)/.test(value)) return 'openai';
  return 'other';
}

/** Vendors a settings provider can serve. `undefined` means every vendor. */
export function vendorsForProvider(provider?: Provider | null): CatalogProvider[] | undefined {
  if (provider === 'openai') return ['openai'];
  if (provider === 'anthropic') return ['anthropic'];
  return undefined;
}

function compareVersions(a: string, b: string) {
  const left = a.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (left[index] || 0) - (right[index] || 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function toPerMillion(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 1_000_000 * 1000) / 1000;
}

function pricingFromLive(model: OpenRouterLiveModel): CatalogPricing | null {
  const inputPerM = toPerMillion(model.pricing?.prompt);
  const outputPerM = toPerMillion(model.pricing?.completion);
  if (inputPerM == null || outputPerM == null) return null;
  return { inputPerM, outputPerM };
}

function releasedAtFromLive(model: OpenRouterLiveModel): string | null {
  const created = Number(model.created);
  if (!Number.isFinite(created) || created <= 0) return null;
  return new Date(created * 1000).toISOString().slice(0, 10);
}

function capabilitiesFrom(
  curated: Partial<CatalogCapabilities> | undefined,
  live: OpenRouterLiveModel | undefined,
  contextTokens: number | null,
): CatalogCapabilities {
  const params = Array.isArray(live?.supported_parameters) ? live!.supported_parameters! : null;
  const inputs = Array.isArray(live?.architecture?.input_modalities)
    ? live!.architecture!.input_modalities!
    : null;
  return {
    reasoning: params ? params.includes('reasoning') : Boolean(curated?.reasoning),
    tools: params ? params.includes('tools') : Boolean(curated?.tools),
    vision: inputs ? inputs.includes('image') : Boolean(curated?.vision),
    pdf: inputs ? inputs.includes('file') : Boolean(curated?.pdf),
    longContext: (contextTokens ?? 0) >= LONG_CONTEXT_TOKENS,
  };
}

export type BuildCatalogInput = {
  /** Raw OpenRouter models. `null` when the live fetch failed. */
  live?: OpenRouterLiveModel[] | null;
  /** The user's settings provider. Direct keys narrow the available vendors. */
  provider?: Provider | null;
};

/** Merge the curated table with the live list and decide each model's status. */
export function buildModelCatalog(input: BuildCatalogInput = {}): CatalogModel[] {
  const liveById = new Map<string, OpenRouterLiveModel>();
  for (const model of input.live || []) {
    const id = String(model?.id || '').trim();
    if (id) liveById.set(id, model);
  }
  const liveKnown = Boolean(input.live && input.live.length > 0);
  const vendors = vendorsForProvider(input.provider);

  const entries = [...CURATED];
  const knownIds = new Set(entries.map((entry) => entry.id));
  for (const live of liveById.values()) {
    const id = live.id!;
    if (knownIds.has(id) || !isOpenRouterModelId(id) || id.endsWith(':batch')) continue;
    if (live.architecture?.output_modalities && !live.architecture.output_modalities.includes('text'))
      continue;
    const name = live.name?.replace(/^[^:]+:\s*/, '') || id.split('/').slice(1).join('/');
    const slug = id.split('/').slice(1).join('/');
    const version = slug.match(/\d+(?:\.\d+)*/)?.[0] ?? '0';
    const family = slug
      .replace(/\d+(?:\.\d+)*/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    const tier: CatalogTier = /nano|luna/.test(slug)
      ? 'nano'
      : /mini|flash|lite|haiku|small/.test(slug)
        ? 'fast'
        : /opus|pro|large/.test(slug)
          ? 'flagship'
          : 'balanced';
    entries.push({
      id,
      name,
      family,
      version,
      tier,
      recommendedFor: [],
      directId: id.startsWith('anthropic/') ? slug.replace(/(\d)\.(\d)/g, '$1-$2') : undefined,
      note: 'Available through OpenRouter.',
    });
  }
  const models: CatalogModel[] = entries.map((entry) => {
    const live = liveById.get(entry.id);
    const provider = providerForModelId(entry.id);
    const contextTokens =
      Number.isFinite(Number(live?.context_length)) && Number(live?.context_length) > 0
        ? Number(live!.context_length)
        : (entry.contextTokens ?? null);
    return {
      id: entry.id,
      directId: entry.directId || entry.id.replace(/^(openai|anthropic)\//, ''),
      provider,
      providerLabel: PROVIDER_LABELS[provider],
      name: entry.name,
      family: entry.family,
      version: entry.version,
      tier: entry.tier,
      capabilities: capabilitiesFrom(entry.capabilities, live, contextTokens),
      contextTokens,
      pricing: (live ? pricingFromLive(live) : null) ?? entry.pricing ?? null,
      releasedAt: (live ? releasedAtFromLive(live) : null) ?? entry.releasedAt ?? null,
      status: 'current',
      replacementId: entry.deprecated?.replacementId,
      recommendedFor: entry.recommendedFor,
      note: entry.note,
    };
  });

  // Deprecation: curated retirement, or gone from a live list we trust.
  for (const model of models) {
    if (model.replacementId) {
      model.status = 'deprecated';
      continue;
    }
    if (liveKnown && !liveById.has(model.id) && input.provider !== model.provider)
      model.status = 'deprecated';
  }

  // Legacy: an older version in a family that has a newer live member.
  const byFamily = new Map<string, CatalogModel[]>();
  for (const model of models) {
    if (model.status === 'deprecated') continue;
    const list = byFamily.get(model.family) || [];
    list.push(model);
    byFamily.set(model.family, list);
  }
  for (const list of byFamily.values()) {
    const newest = list.reduce((best, model) =>
      compareVersions(model.version, best.version) > 0 ? model : best,
    );
    for (const model of list) {
      if (model !== newest && !PINNED_IDS.has(model.id)) model.status = 'legacy';
    }
  }

  // A replacement must be available and use the same vendor.
  for (const model of models) {
    if (model.status !== 'deprecated') continue;
    const available = models.filter(
      (candidate) =>
        candidate.id !== model.id &&
        candidate.status !== 'deprecated' &&
        candidate.provider === model.provider,
    );
    const explicit = available.find((candidate) => candidate.id === model.replacementId);
    const family = available.find(
      (candidate) => candidate.family === model.family && candidate.status === 'current',
    );
    const defaults = defaultModelsFor(model.provider === 'anthropic' ? 'anthropic' : 'openrouter');
    const fallback = available.find(
      (candidate) => candidate.id === defaults[FAST_TIERS.has(model.tier) ? 'fast' : 'normal'],
    );
    const similar = available.find(
      (candidate) => candidate.tier === model.tier && candidate.status === 'current',
    );
    model.replacementId = (explicit ?? family ?? fallback ?? similar)?.id;
  }

  for (const model of models) {
    model.catalogStatus = model.status as Exclude<CatalogStatus, 'unavailable'>;
    if (vendors && !vendors.includes(model.provider)) model.status = 'unavailable';
  }

  return sortCatalog(models);
}

export function sortCatalog(models: CatalogModel[]): CatalogModel[] {
  const rank = new Map(PROVIDER_ORDER.map((provider, index) => [provider, index]));
  return [...models].sort((a, b) => {
    const providerDelta = (rank.get(a.provider) ?? 99) - (rank.get(b.provider) ?? 99);
    if (providerDelta !== 0) return providerDelta;
    return a.name.localeCompare(b.name, 'en', { numeric: true });
  });
}

/** Find a catalog model by canonical id or direct id. */
export function findCatalogModel(catalog: CatalogModel[], value?: string | null): CatalogModel | undefined {
  const needle = (value || '')
    .trim()
    .toLowerCase()
    .replace(/-20\d{6}$/, '');
  if (!needle) return undefined;
  return catalog.find(
    (model) => model.id.toLowerCase() === needle || model.directId.toLowerCase() === needle,
  );
}

/** Platform defaults per settings provider, as canonical ids. */
export function defaultModelsFor(provider?: Provider | null): { normal: string; fast: string } {
  if (provider === 'anthropic') {
    return { normal: 'anthropic/claude-sonnet-4.6', fast: 'anthropic/claude-haiku-4.5' };
  }
  return { normal: OPENROUTER_DEFAULT_PRIMARY_MODEL, fast: OPENROUTER_DEFAULT_FAST_MODEL };
}

export type SavedModelResolution = {
  /** The id the runtime should send: canonical for OpenRouter, direct for a vendor key. */
  id: string;
  /** The saved id as given. */
  savedId: string;
  known: boolean;
  deprecated: boolean;
  model?: CatalogModel;
  replacement?: CatalogModel;
};

/**
 * Resolve a saved model id against the catalog. A retired model resolves to
 * its replacement so a stale setting never reaches the provider. Unknown ids
 * pass through unchanged (OpenRouter power users type their own).
 */
export function resolveSavedModel(
  savedId: string | null | undefined,
  catalog: CatalogModel[],
  options: { provider?: Provider | null } = {},
): SavedModelResolution {
  const trimmed = (savedId || '').trim();
  const direct = options.provider === 'openai' || options.provider === 'anthropic';
  const model = findCatalogModel(catalog, trimmed);
  if (!model) return { id: trimmed, savedId: trimmed, known: false, deprecated: false };
  let target = model;
  const seen = new Set<string>([model.id]);
  while (target.status === 'deprecated' && target.replacementId && !seen.has(target.replacementId)) {
    const next = findCatalogModel(catalog, target.replacementId);
    if (!next) break;
    seen.add(next.id);
    target = next;
  }
  const deprecated = model.status === 'deprecated';
  return {
    id: direct ? target.directId : target.id,
    savedId: trimmed,
    known: true,
    deprecated,
    model,
    replacement:
      deprecated && target.status !== 'deprecated' && target.status !== 'unavailable' ? target : undefined,
  };
}

let staticCatalog: CatalogModel[] | null = null;

/** The curated catalog without live data. Used by the runtime hot path. */
export function staticModelCatalog(): CatalogModel[] {
  if (!staticCatalog) staticCatalog = buildModelCatalog();
  return staticCatalog;
}

/**
 * Runtime helper: the id to send for a saved setting. Retired ids move to
 * their replacement; direct providers get the vendor's own id form.
 */
export function resolveSavedModelId(
  savedId: string | null | undefined,
  provider?: Provider | null,
  catalog = staticModelCatalog(),
) {
  const resolution = resolveSavedModel(savedId, catalog, { provider });
  if (resolution.deprecated && !resolution.replacement)
    throw new Error('The selected model is retired. Choose another model in AI settings.');
  if (
    resolution.model?.status === 'unavailable' ||
    (resolution.model && provider && provider !== 'openrouter' && resolution.model.provider !== provider)
  )
    throw new Error('The selected model is not available with this provider key.');
  return resolution.id || undefined;
}

export type ModelChoiceValidation =
  | { ok: true; id: string; unknown: boolean; replaced?: string }
  | { ok: false; error: string };

/**
 * Validate a posted model choice for a provider. Returns the id to persist:
 * canonical for OpenRouter, direct for a vendor key. Unknown OpenRouter ids
 * are accepted when they are well formed and flagged `unknown`.
 */
export function validateModelChoice(input: {
  provider: Provider;
  slot: CatalogSlot;
  value?: string | null;
  catalog: CatalogModel[];
}): ModelChoiceValidation {
  const value = (input.value || '').trim();
  if (!value) {
    const defaults = defaultModelsFor(input.provider);
    const resolved = resolveSavedModel(defaults[input.slot], input.catalog, { provider: input.provider });
    return validateModelChoice({ ...input, value: resolved.id });
  }
  const resolution = resolveSavedModel(value, input.catalog, { provider: input.provider });
  if (resolution.known) {
    if (resolution.deprecated && !resolution.replacement)
      return { ok: false, error: 'This model is retired. Choose an available model.' };
    const target = resolution.replacement ?? resolution.model!;
    if (
      target.status === 'unavailable' ||
      (input.provider !== 'openrouter' && target.provider !== input.provider)
    ) {
      return {
        ok: false,
        error: `${target.name} needs an OpenRouter key or a ${target.providerLabel} key.`,
      };
    }
    return {
      ok: true,
      id: resolution.id,
      unknown: false,
      replaced: resolution.deprecated ? resolution.model!.id : undefined,
    };
  }
  if (input.provider === 'openrouter') {
    if (!isOpenRouterModelId(value)) {
      return { ok: false, error: `${value} is not a valid OpenRouter model id (vendor/model).` };
    }
    return { ok: true, id: value, unknown: true };
  }
  return {
    ok: false,
    error: `${value} is not a ${PROVIDER_LABELS[input.provider === 'openai' ? 'openai' : 'anthropic']} model in the catalog.`,
  };
}

/** The provider whose catalog the user sees: every vendor in lab86 mode. */
export function catalogProviderFor(
  settings: { mode?: string; provider?: string | null } | null | undefined,
  keyProvider?: string | null,
): Provider {
  if (!settings || settings.mode !== 'byok') return 'openrouter';
  const provider = settings.provider || keyProvider || 'openrouter';
  return provider === 'openai' || provider === 'anthropic' ? provider : 'openrouter';
}

export type SavedModelSummary = {
  savedId: string;
  id: string;
  known: boolean;
  deprecated: boolean;
  replacementId?: string;
  replacementName?: string;
};

/** Compact saved-model report for the settings page. */
export function savedModelSummary(
  savedId: string | null | undefined,
  catalog: CatalogModel[],
  provider: Provider,
): SavedModelSummary {
  const resolution = resolveSavedModel(savedId, catalog, { provider });
  return {
    savedId: resolution.savedId,
    id: resolution.model?.id ?? resolution.savedId,
    known: resolution.known,
    deprecated: resolution.deprecated,
    replacementId: resolution.replacement?.id,
    replacementName: resolution.replacement?.name,
  };
}

export type ProvidersAvailable = Record<CatalogProvider, boolean>;

export function providersAvailableFor(provider?: Provider | null): ProvidersAvailable {
  const vendors = vendorsForProvider(provider);
  return Object.fromEntries(
    PROVIDER_ORDER.map((vendor) => [vendor, vendors ? vendors.includes(vendor) : true]),
  ) as ProvidersAvailable;
}

/** Live-merged catalog for a settings provider. The fetch is cached for an hour. */
export async function loadModelCatalog(input: { provider?: Provider | null } = {}) {
  const live = await fetchOpenRouterCatalog();
  return {
    catalog: buildModelCatalog({ live: live.live ? live.data : null, provider: input.provider }),
    live: live.live,
    liveData: live.data,
  };
}

/** Compact context label: 1M, 400k, 8k. */
export function formatContextTokens(value: number | null | undefined): string | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1_000_000) return `${String(Math.floor(n / 100_000) / 10).replace(/\.0$/, '')}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** Compact price label: $5 / $30 per M tokens. */
export function formatPricing(pricing: CatalogPricing | null | undefined): string | null {
  if (!pricing) return null;
  const money = (value: number) =>
    value >= 1 ? `$${value.toFixed(value % 1 === 0 ? 0 : 2)}` : `$${value.toFixed(2)}`;
  return `${money(pricing.inputPerM)} / ${money(pricing.outputPerM)}`;
}

let runtimeCatalogCache: { catalog: CatalogModel[]; at: number } | undefined;
let runtimeCatalogPending: Promise<CatalogModel[]> | undefined;
export function loadRuntimeModelCatalog(): Promise<CatalogModel[]> {
  if (runtimeCatalogCache && Date.now() - runtimeCatalogCache.at < 3_600_000) {
    return Promise.resolve(runtimeCatalogCache.catalog);
  }
  if (!runtimeCatalogPending) {
    runtimeCatalogPending = loadModelCatalog()
      .then((loaded) => {
        const catalog = loaded.live ? loaded.catalog : (runtimeCatalogCache?.catalog ?? loaded.catalog);
        if (loaded.live) runtimeCatalogCache = { catalog, at: Date.now() };
        return catalog;
      })
      .finally(() => {
        runtimeCatalogPending = undefined;
      });
  }
  return runtimeCatalogPending;
}
