export type Provider = 'openrouter' | 'openai' | 'anthropic';
export type Lab86ModelFamily = 'openai' | 'claude';

export type ModelOption = {
  id: string;
  label: string;
  detail: string;
};

export const OPENROUTER_DEFAULT_PRIMARY_MODEL = 'openai/gpt-5.5';
export const OPENROUTER_DEFAULT_FAST_MODEL = 'openai/gpt-5.4-mini';

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
    id: 'openai/gpt-5.4-mini',
    label: 'GPT-5.4 Mini',
    detail: 'Default fast model for summaries, labels, and quick drafts.',
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
  {
    id: 'openai/gpt-5-nano',
    label: 'GPT-5 Nano',
    detail: 'Lowest-latency OpenAI option for small tasks.',
  },
];

export const LAB86_MODEL_FAMILIES: Record<
  Lab86ModelFamily,
  { label: string; primary: string; fast: string; detail: string }
> = {
  openai: {
    label: 'OpenAI',
    primary: OPENROUTER_DEFAULT_PRIMARY_MODEL,
    fast: OPENROUTER_DEFAULT_FAST_MODEL,
    detail: 'GPT-5.5 for deeper work, GPT-5.4 Mini for fast tasks',
  },
  claude: {
    label: 'Claude',
    primary: 'anthropic/claude-sonnet-4.6',
    fast: 'anthropic/claude-haiku-4.5',
    detail: 'Sonnet 4.6 for deeper work, Haiku 4.5 for fast tasks',
  },
};

const primaryIds = new Set(OPENROUTER_PRIMARY_MODEL_OPTIONS.map((option) => option.id));
const fastIds = new Set(OPENROUTER_FAST_MODEL_OPTIONS.map((option) => option.id));

export function resolveLab86Family(model?: string, fastModel?: string): Lab86ModelFamily {
  const primary = model || '';
  if (primary) return primary.includes('anthropic/') ? 'claude' : 'openai';
  return fastModel?.includes('anthropic/') ? 'claude' : 'openai';
}

export function isOpenRouterPrimaryModel(value?: string | null) {
  return Boolean(value && primaryIds.has(value));
}

export function isOpenRouterFastModel(value?: string | null) {
  return Boolean(value && fastIds.has(value));
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
