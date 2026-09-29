import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { captureGenerationIdFetch } from './generation-cost';
import { createOpenRouterProvider } from './openrouter-policy';

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';

// OpenRouter is OpenAI-compatible; route through @ai-sdk/openai with a custom baseURL.
// Model ids on OpenRouter use a vendor prefix (e.g. "openai/gpt-5.5"). Every
// request carries the no-training data policy (./openrouter-policy).
const OPENROUTER_DEFAULT_PRIMARY = 'openai/gpt-5.5';
const OPENROUTER_DEFAULT_FAST = 'openai/gpt-5-nano';

const OPENAI_DEFAULT_PRIMARY = 'gpt-5.5';
const OPENAI_DEFAULT_FAST = 'gpt-5-nano';

// The data policy wraps the generation-id capture: each request carries
// `data_collection: 'deny'` (lib/ai/openrouter-policy.ts), and each response
// notes its generation id, so a failed or stopped call can still record its
// real cost (lib/ai/generation-cost.ts).
export const openrouter = OPENROUTER_KEY
  ? createOpenRouterProvider(OPENROUTER_KEY, { fetch: captureGenerationIdFetch() })
  : null;
export const openai = OPENAI_KEY ? createOpenAI({ apiKey: OPENAI_KEY }) : null;
export const anthropic = ANTHROPIC_KEY ? createAnthropic({ apiKey: ANTHROPIC_KEY }) : null;

/** Which platform providers have a key. A test can pass its own set. */
export type ConfiguredProviders = { openrouter: unknown; openai: unknown; anthropic: unknown };
const CONFIGURED: ConfiguredProviders = { openrouter, openai, anthropic };

export function pickPrimaryModel(
  configured: ConfiguredProviders = CONFIGURED,
  env: Record<string, string | undefined> = process.env,
) {
  if (configured.openrouter) return env.LAB86_MAIL_OPENAI_MODEL || OPENROUTER_DEFAULT_PRIMARY;
  if (configured.openai) return env.LAB86_MAIL_OPENAI_MODEL || OPENAI_DEFAULT_PRIMARY;
  return '';
}

export function pickFastModel(
  configured: ConfiguredProviders = CONFIGURED,
  env: Record<string, string | undefined> = process.env,
) {
  if (configured.openrouter) return env.LAB86_MAIL_OPENAI_FAST_MODEL || OPENROUTER_DEFAULT_FAST;
  if (configured.openai) return env.LAB86_MAIL_OPENAI_FAST_MODEL || OPENAI_DEFAULT_FAST;
  return '';
}

export const OPENAI_PRIMARY_MODEL = pickPrimaryModel();
export const OPENAI_FAST_MODEL = pickFastModel();

export function hasAi() {
  return Boolean(openrouter || openai || anthropic);
}

export function describeProvider(configured: ConfiguredProviders = CONFIGURED) {
  if (configured.openrouter)
    return { provider: 'openrouter', primary: pickPrimaryModel(configured), fast: pickFastModel(configured) };
  if (configured.openai)
    return { provider: 'openai', primary: pickPrimaryModel(configured), fast: pickFastModel(configured) };
  if (configured.anthropic)
    return { provider: 'anthropic', primary: 'claude-sonnet-4-6', fast: 'claude-haiku-4-5-20251001' };
  return { provider: 'none', primary: '', fast: '' };
}
