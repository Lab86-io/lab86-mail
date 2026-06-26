import { describe, expect, test } from 'bun:test';
import {
  isOpenRouterFastModel,
  isOpenRouterPrimaryModel,
  normalizeOpenRouterFastModel,
  normalizeOpenRouterPrimaryModel,
  OPENROUTER_DEFAULT_FAST_MODEL,
  OPENROUTER_DEFAULT_PRIMARY_MODEL,
  OPENROUTER_FAST_MODEL_OPTIONS,
  OPENROUTER_PRIMARY_MODEL_OPTIONS,
} from '../lib/ai/model-options';

describe('OpenRouter model normalization', () => {
  test('recognizes catalog primary and fast models', () => {
    expect(isOpenRouterPrimaryModel('openai/gpt-5.5')).toBe(true);
    expect(isOpenRouterFastModel('openai/gpt-5-nano')).toBe(true);
    expect(isOpenRouterFastModel('openai/gpt-5.4-mini')).toBe(true);
  });
  test('preserves unknown but well-formed slugs', () => {
    expect(normalizeOpenRouterPrimaryModel('some-provider/unreviewed-model')).toBe(
      'some-provider/unreviewed-model',
    );
    expect(normalizeOpenRouterFastModel('some-provider/unreviewed-fast-model')).toBe(
      'some-provider/unreviewed-fast-model',
    );
  });
  test('falls back to defaults for invalid values', () => {
    expect(normalizeOpenRouterPrimaryModel('')).toBe(OPENROUTER_DEFAULT_PRIMARY_MODEL);
    expect(normalizeOpenRouterFastModel('not-a-model')).toBe(OPENROUTER_DEFAULT_FAST_MODEL);
  });
});

describe('OpenRouter model catalogs', () => {
  test('includes default primary and fast entries', () => {
    expect(OPENROUTER_PRIMARY_MODEL_OPTIONS.some((option) => option.id === OPENROUTER_DEFAULT_PRIMARY_MODEL)).toBe(
      true,
    );
    expect(OPENROUTER_FAST_MODEL_OPTIONS.some((option) => option.id === OPENROUTER_DEFAULT_FAST_MODEL)).toBe(true);
  });
});
