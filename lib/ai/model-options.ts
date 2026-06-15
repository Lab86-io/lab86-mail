export type Provider = 'openrouter' | 'openai' | 'anthropic';

export type ModelOption = {
  id: string;
  label: string;
  detail: string;
};

export const OPENROUTER_DEFAULT_PRIMARY_MODEL = 'openai/gpt-5.5';
export const OPENROUTER_DEFAULT_FAST_MODEL = 'openai/gpt-5-nano';

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const OPENROUTER_MODEL_FETCH_TIMEOUT_MS = 3500;

export const OPENROUTER_PRIMARY_MODEL_OPTIONS: ModelOption[] = [
  {
    id: 'openai/gpt-5.5',
    label: 'GPT-5.5',
    detail: 'OpenAI flagship model for complex mail reasoning and drafting.',
  },
  {
    id: 'anthropic/claude-sonnet-4.6',
    label: 'Claude Sonnet 4.6',
    detail: 'Strong long-context analysis and careful writing.',
  },
  {
    id: 'google/gemini-3.5-flash',
    label: 'Gemini 3.5 Flash',
    detail: 'Large-context model with balanced latency and cost.',
  },
  {
    id: 'x-ai/grok-4.3',
    label: 'Grok 4.3',
    detail: 'High-context general reasoning model.',
  },
  {
    id: 'deepseek/deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    detail: 'DeepSeek model for heavier analysis at OpenRouter pricing.',
  },
  {
    id: 'moonshotai/kimi-k2.6',
    label: 'Kimi K2.6',
    detail: 'Long-context reasoning model from Moonshot AI.',
  },
  {
    id: 'qwen/qwen3-coder',
    label: 'Qwen3 Coder',
    detail: 'Useful for technical email, code, and structured agent tasks.',
  },
  {
    id: 'openai/gpt-5.1-chat',
    label: 'GPT-5.1 Chat',
    detail: 'Fast conversational OpenAI model for mail workflows.',
  },
];

export const OPENROUTER_FAST_MODEL_OPTIONS: ModelOption[] = [
  {
    id: 'openai/gpt-5-nano',
    label: 'GPT-5 Nano',
    detail: 'Default fast model for summaries, labels, and quick drafts.',
  },
  {
    id: 'openai/gpt-5.4-nano',
    label: 'GPT-5.4 Nano',
    detail: 'Nano-family OpenAI model when available for your OpenRouter account.',
  },
  {
    id: 'openai/gpt-5.4-mini',
    label: 'GPT-5.4 Mini',
    detail: 'A little heavier than nano while still optimized for fast mail workflows.',
  },
  {
    id: 'anthropic/claude-haiku-4.5',
    label: 'Claude Haiku 4.5',
    detail: 'Low-latency Anthropic model for lightweight mail tasks.',
  },
  {
    id: 'google/gemini-3.1-flash-lite',
    label: 'Gemini 3.1 Flash Lite',
    detail: 'Large-context fast path with low cost.',
  },
  {
    id: 'deepseek/deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    detail: 'Fast DeepSeek model for quick classification and extraction.',
  },
  {
    id: 'qwen/qwen3.6-flash',
    label: 'Qwen3.6 Flash',
    detail: 'Fast Qwen model with a large context window.',
  },
];

const primaryIds = new Set(OPENROUTER_PRIMARY_MODEL_OPTIONS.map((option) => option.id));
const fastIds = new Set(OPENROUTER_FAST_MODEL_OPTIONS.map((option) => option.id));

function isOpenRouterModelId(value?: string | null) {
  return Boolean(value && /^[~a-z0-9][a-z0-9._~/-]*(?::[a-z0-9._-]+)?$/i.test(value) && value.includes('/'));
}

export function isOpenRouterPrimaryModel(value?: string | null) {
  return Boolean(value && (primaryIds.has(value) || isOpenRouterModelId(value)));
}

export function isOpenRouterFastModel(value?: string | null) {
  return Boolean(value && (fastIds.has(value) || isOpenRouterModelId(value)));
}

export function normalizeOpenRouterPrimaryModel(value?: string | null) {
  return isOpenRouterPrimaryModel(value) ? value! : OPENROUTER_DEFAULT_PRIMARY_MODEL;
}

export function normalizeOpenRouterFastModel(value?: string | null) {
  return isOpenRouterFastModel(value) ? value! : OPENROUTER_DEFAULT_FAST_MODEL;
}

export function setProviderForByok(
  value: Provider,
  setProvider: (provider: Provider) => void,
  setModel: (model: string) => void,
  setFastModel: (model: string) => void,
) {
  setProvider(value);
  if (value === 'openrouter') {
    setModel(normalizeOpenRouterPrimaryModel());
    setFastModel(normalizeOpenRouterFastModel());
  } else {
    setModel('');
    setFastModel('');
  }
}

function openRouterLabel(model: any): string {
  const name = String(model?.name || '').replace(/^(OpenAI|Anthropic|Google|Meta|Qwen|DeepSeek):\s*/i, '');
  return name || String(model?.id || '');
}

function formatContextLength(value: unknown): string | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M context`;
  if (n >= 1000) return `${Math.round(n / 1000)}k context`;
  return `${n} context`;
}

function openRouterDetail(model: any): string {
  const context = formatContextLength(model?.context_length);
  const prompt = Number(model?.pricing?.prompt);
  const completion = Number(model?.pricing?.completion);
  const price =
    Number.isFinite(prompt) && Number.isFinite(completion) && prompt >= 0 && completion >= 0
      ? `$${(prompt * 1_000_000).toFixed(prompt * 1_000_000 >= 1 ? 2 : 3)}/M in, $${(
          completion * 1_000_000
        ).toFixed(completion * 1_000_000 >= 1 ? 2 : 3)}/M out`
      : null;
  return [context, price].filter(Boolean).join(' · ') || String(model?.description || '').slice(0, 160);
}

function optionFromOpenRouterModel(model: any): ModelOption | null {
  const id = String(model?.id || '').trim();
  if (!isOpenRouterModelId(id)) return null;
  const outputModalities = model?.architecture?.output_modalities;
  if (Array.isArray(outputModalities) && !outputModalities.includes('text')) return null;
  return {
    id,
    label: openRouterLabel(model),
    detail: openRouterDetail(model),
  };
}

function pinDefaults(options: ModelOption[], fallback: ModelOption[]): ModelOption[] {
  const byId = new Map<string, ModelOption>();
  for (const option of options) byId.set(option.id, option);
  for (const option of fallback) {
    if (!byId.has(option.id)) byId.set(option.id, option);
  }
  const pinnedIds = [OPENROUTER_DEFAULT_PRIMARY_MODEL, OPENROUTER_DEFAULT_FAST_MODEL];
  const pinned = pinnedIds.map((id) => byId.get(id)).filter(Boolean) as ModelOption[];
  const rest = [...byId.values()].filter((option) => !pinnedIds.includes(option.id));
  return [...pinned, ...rest];
}

export async function loadOpenRouterModelOptions(): Promise<{
  primary: ModelOption[];
  fast: ModelOption[];
  live: boolean;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENROUTER_MODEL_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(OPENROUTER_MODELS_URL, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
      next: { revalidate: 60 * 60 },
    } as RequestInit);
    if (!response.ok) throw new Error(`OpenRouter model catalog returned ${response.status}`);
    const json = (await response.json()) as { data?: any[] };
    const all = (json.data || []).map(optionFromOpenRouterModel).filter(Boolean) as ModelOption[];
    const fast = all.filter((option) => /(?:nano|mini|flash|haiku|lite|small|speed|fast)/i.test(option.id));
    return {
      primary: pinDefaults(all, OPENROUTER_PRIMARY_MODEL_OPTIONS),
      fast: pinDefaults(fast.length ? fast : all, OPENROUTER_FAST_MODEL_OPTIONS),
      live: true,
    };
  } catch {
    return {
      primary: OPENROUTER_PRIMARY_MODEL_OPTIONS,
      fast: OPENROUTER_FAST_MODEL_OPTIONS,
      live: false,
    };
  } finally {
    clearTimeout(timeout);
  }
}
