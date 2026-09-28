import { describe, expect, test } from 'bun:test';
import {
  AI_BUDGET_SOFT_LIMIT_RATIO,
  B2C_INTERNAL_MONTHLY_CREDITS,
  estimateAiUsageCost,
  isAiChatFeature,
  resolveAiBudgetPolicy,
  shouldDepleteLab86Budget,
} from '../lib/ai/budget';

describe('estimateAiUsageCost', () => {
  test('GLM variants retain the vendor prefix and use the same base rate', () => {
    for (const model of ['z-ai/glm-5.3-flash', 'z-ai/glm-5.3-flash:batch', 'Z-AI/GLM-5.3-FLASH:nitro']) {
      expect(
        estimateAiUsageCost({
          provider: 'openrouter',
          model,
          promptTokens: 1000000,
          completionTokens: 1000000,
        }).estimatedCostUsd,
      ).toBeCloseTo(0.65);
    }
  });
  test('uses OpenRouter list prices for models the generic rules priced wrong', () => {
    const million = (provider: 'openrouter' | 'openai' | 'anthropic', model: string) =>
      estimateAiUsageCost({ provider, model, promptTokens: 1_000_000, completionTokens: 1_000_000 })
        .estimatedCostUsd;
    // Input + output for 1M tokens each, from the 2026-09-27 OpenRouter catalog.
    expect(million('openrouter', 'openai/gpt-5.6-luna')).toBeCloseTo(1.4);
    expect(million('openai', 'gpt-5.6-luna')).toBeCloseTo(1.4);
    expect(million('openrouter', 'google/gemini-2.5-flash-lite')).toBeCloseTo(0.5);
    expect(million('openrouter', 'openai/gpt-5.4-mini')).toBeCloseTo(5.25);
    expect(million('openrouter', 'openai/gpt-5.6-terra')).toBeCloseTo(14);
    expect(million('openrouter', 'anthropic/claude-opus-5.5')).toBeCloseTo(24);
    expect(million('anthropic', 'claude-opus-5-5')).toBeCloseTo(24);
    // Other models keep their generic rules.
    expect(million('openrouter', 'anthropic/claude-sonnet-4.6')).toBeCloseTo(18);
    const cached = estimateAiUsageCost({
      provider: 'openrouter',
      model: 'openai/gpt-5.6-luna',
      promptTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
    });
    expect(cached.estimatedCostUsd).toBeCloseTo(0.02);
  });
  test('a cheap call counts its exact credits, with no round-up', () => {
    // One Jev verdict: 4,646 input tokens at $0.042 per million.
    const jev = estimateAiUsageCost({
      provider: 'openrouter',
      model: 'typesafe/jev-1.13-20260917',
      promptTokens: 4_646,
      completionTokens: 300,
    });
    expect(jev.estimatedCredits).toBeCloseTo(0.019513, 6);
    expect(
      estimateAiUsageCost({ provider: 'openrouter', model: 'openai/gpt-5-nano', promptTokens: 0 })
        .estimatedCredits,
    ).toBe(0);
  });
});

describe('resolveAiBudgetPolicy', () => {
  test('soft-limits at 80% and hard-stops chat at 100%', () => {
    const soft = resolveAiBudgetPolicy({
      feature: 'daily_report_narrative',
      monthlyCredits: B2C_INTERNAL_MONTHLY_CREDITS,
      creditsUsed: B2C_INTERNAL_MONTHLY_CREDITS * AI_BUDGET_SOFT_LIMIT_RATIO,
    });
    expect(soft.softLimited).toBe(true);
    expect(soft.hardStopped).toBe(false);

    const chat = resolveAiBudgetPolicy({
      feature: 'agent',
      monthlyCredits: B2C_INTERNAL_MONTHLY_CREDITS,
      creditsUsed: B2C_INTERNAL_MONTHLY_CREDITS,
    });
    expect(chat.hardStopped).toBe(true);

    const classify = resolveAiBudgetPolicy({
      feature: 'classify_threads',
      monthlyCredits: B2C_INTERNAL_MONTHLY_CREDITS,
      creditsUsed: B2C_INTERNAL_MONTHLY_CREDITS,
    });
    expect(classify.hardStopped).toBe(false);
    expect(classify.forceFastModel).toBe(true);
  });
});

describe('budget helpers', () => {
  test('identifies chat features and budget sources', () => {
    expect(isAiChatFeature('agent')).toBe(true);
    expect(isAiChatFeature('chat')).toBe(true);
    expect(isAiChatFeature('classify_threads')).toBe(false);
    expect(shouldDepleteLab86Budget('lab86')).toBe(true);
    expect(shouldDepleteLab86Budget('byok')).toBe(false);
  });
});
