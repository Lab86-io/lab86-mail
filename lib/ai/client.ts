import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';

const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';

export const OPENAI_PRIMARY_MODEL = process.env.MAIL_OS_OPENAI_MODEL || 'gpt-5.5';
export const OPENAI_FAST_MODEL = process.env.MAIL_OS_OPENAI_FAST_MODEL || 'gpt-5.5-mini';

export const openai = OPENAI_KEY ? createOpenAI({ apiKey: OPENAI_KEY }) : null;
export const anthropic = ANTHROPIC_KEY ? createAnthropic({ apiKey: ANTHROPIC_KEY }) : null;

export function primaryModel() {
  if (openai) return openai(OPENAI_PRIMARY_MODEL);
  if (anthropic) return anthropic('claude-sonnet-4-6');
  throw new Error('No AI provider configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.');
}

export function fastModel() {
  if (openai) return openai(OPENAI_FAST_MODEL);
  if (anthropic) return anthropic('claude-haiku-4-5-20251001');
  throw new Error('No AI provider configured.');
}

export function hasAi() {
  return Boolean(openai || anthropic);
}

export function describeProvider() {
  if (openai) return { provider: 'openai', primary: OPENAI_PRIMARY_MODEL, fast: OPENAI_FAST_MODEL };
  if (anthropic) return { provider: 'anthropic', primary: 'claude-sonnet-4-6', fast: 'claude-haiku-4-5-20251001' };
  return { provider: 'none', primary: '', fast: '' };
}
