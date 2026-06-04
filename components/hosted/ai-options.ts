export type Provider = 'openrouter' | 'openai' | 'anthropic';
export type Lab86ModelFamily = 'openai' | 'claude';

export const LAB86_MODEL_FAMILIES: Record<
  Lab86ModelFamily,
  { label: string; primary: string; fast: string; detail: string }
> = {
  openai: {
    label: 'OpenAI',
    primary: 'openai/gpt-5.5',
    fast: 'openai/gpt-5.4-mini',
    detail: 'GPT-5.5 for deeper work, GPT-5.4 Mini for fast tasks',
  },
  claude: {
    label: 'Claude',
    primary: 'anthropic/claude-sonnet-4.6',
    fast: 'anthropic/claude-haiku-4.5',
    detail: 'Sonnet 4.6 for deeper work, Haiku 4.5 for fast tasks',
  },
};

export function resolveLab86Family(model?: string, fastModel?: string): Lab86ModelFamily {
  const ids = `${model || ''} ${fastModel || ''}`;
  return ids.includes('anthropic/') ? 'claude' : 'openai';
}
