import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';

// OpenRouter is OpenAI-compatible; route through @ai-sdk/openai with a custom baseURL.
// Model ids on OpenRouter use a vendor prefix (e.g. "openai/gpt-5.5").
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENROUTER_DEFAULT_PRIMARY = 'openai/gpt-5.5';
const OPENROUTER_DEFAULT_FAST = 'openai/gpt-5.4-mini';

const OPENAI_DEFAULT_PRIMARY = 'gpt-5.5';
const OPENAI_DEFAULT_FAST = 'gpt-5.5-mini';

export const openrouter = OPENROUTER_KEY
  ? createOpenAI({
      apiKey: OPENROUTER_KEY,
      baseURL: OPENROUTER_BASE_URL,
      // Recommended (and used to attribute usage in OpenRouter dashboards):
      headers: {
        'HTTP-Referer': process.env.MAIL_OS_PUBLIC_URL || 'https://mail.lab86.io',
        'X-Title': 'Mail OS',
      },
    })
  : null;
export const openai = OPENAI_KEY ? createOpenAI({ apiKey: OPENAI_KEY }) : null;
export const anthropic = ANTHROPIC_KEY ? createAnthropic({ apiKey: ANTHROPIC_KEY }) : null;

function pickPrimaryModel() {
  if (openrouter) return process.env.MAIL_OS_OPENAI_MODEL || OPENROUTER_DEFAULT_PRIMARY;
  if (openai) return process.env.MAIL_OS_OPENAI_MODEL || OPENAI_DEFAULT_PRIMARY;
  return '';
}

function pickFastModel() {
  if (openrouter) return process.env.MAIL_OS_OPENAI_FAST_MODEL || OPENROUTER_DEFAULT_FAST;
  if (openai) return process.env.MAIL_OS_OPENAI_FAST_MODEL || OPENAI_DEFAULT_FAST;
  return '';
}

export const OPENAI_PRIMARY_MODEL = pickPrimaryModel();
export const OPENAI_FAST_MODEL = pickFastModel();

export function primaryModel() {
  // OpenRouter only speaks Chat Completions reliably across its backends; the
  // Responses API tool-call format (which @ai-sdk/openai uses by default)
  // breaks on its Azure provider for tool follow-ups.
  if (openrouter) return openrouter.chat(OPENAI_PRIMARY_MODEL);
  if (openai) return openai(OPENAI_PRIMARY_MODEL);
  if (anthropic) return anthropic('claude-sonnet-4-6');
  throw new Error('No AI provider configured. Set OPENROUTER_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY.');
}

export function fastModel() {
  if (openrouter) return openrouter.chat(OPENAI_FAST_MODEL);
  if (openai) return openai(OPENAI_FAST_MODEL);
  if (anthropic) return anthropic('claude-haiku-4-5-20251001');
  throw new Error('No AI provider configured.');
}

export function hasAi() {
  return Boolean(openrouter || openai || anthropic);
}

export function describeProvider() {
  if (openrouter) return { provider: 'openrouter', primary: OPENAI_PRIMARY_MODEL, fast: OPENAI_FAST_MODEL };
  if (openai) return { provider: 'openai', primary: OPENAI_PRIMARY_MODEL, fast: OPENAI_FAST_MODEL };
  if (anthropic) return { provider: 'anthropic', primary: 'claude-sonnet-4-6', fast: 'claude-haiku-4-5-20251001' };
  return { provider: 'none', primary: '', fast: '' };
}
