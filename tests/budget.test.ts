import { describe, expect, test } from 'bun:test';
import {
  AI_BUDGET_SOFT_LIMIT_RATIO,
  B2C_INTERNAL_MONTHLY_CREDITS,
  estimateAiUsageCost,
  isAiChatFeature,
  providerReportedCostUsd,
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
  test('a cost the provider reported replaces the price-table estimate', () => {
    const reported = estimateAiUsageCost({
      provider: 'openrouter',
      model: 'openai/gpt-5.5',
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      costUsd: 0.25,
    });
    expect(reported).toMatchObject({ estimatedCostUsd: 0.25, estimatedCredits: 25, reported: true });
    for (const costUsd of [undefined, Number.NaN, -1]) {
      const estimate = estimateAiUsageCost({
        provider: 'openrouter',
        model: 'openai/gpt-5.5',
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
        costUsd,
      });
      expect(estimate).toMatchObject({ estimatedCostUsd: 35, reported: false });
    }
  });
  test('reads the OpenRouter cost from each step body and needs it on every step', () => {
    const step = (cost: unknown) => ({ response: { body: { usage: { prompt_tokens: 10, cost } } } });
    expect(providerReportedCostUsd({ steps: [step(0.001), step(0.002)] })).toBeCloseTo(0.003);
    expect(providerReportedCostUsd(step(0.004))).toBeCloseTo(0.004);
    expect(providerReportedCostUsd({ steps: [], ...step(0) })).toBe(0);
    expect(providerReportedCostUsd({ steps: [step(0.001), step(undefined)] })).toBeUndefined();
    expect(providerReportedCostUsd({ response: { body: { usage: { cost: null } } } })).toBeUndefined();
    expect(providerReportedCostUsd({ response: {} })).toBeUndefined();
    expect(providerReportedCostUsd(undefined)).toBeUndefined();
  });
  test('prices OpenAI GPT-5.5 at list rates', () => {
    const cost = estimateAiUsageCost({
      provider: 'openai',
      model: 'gpt-5.5',
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    });
    expect(cost.estimatedCostUsd).toBe(35);
    expect(cost.estimatedCredits).toBe(3500);
  });
  test('prices Anthropic cache reads and batch discounts', () => {
    const cached = estimateAiUsageCost({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      promptTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      completionTokens: 1_000_000,
    });
    const batched = estimateAiUsageCost({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      batch: true,
    });
    expect(cached.estimatedCostUsd).toBeCloseTo(15.3, 5);
    expect(batched.estimatedCostUsd).toBe(9);
  });
  test('supports OpenRouter-prefixed model ids', () => {
    const cost = estimateAiUsageCost({
      provider: 'openrouter',
      model: 'openai/gpt-5-nano',
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    });
    expect(cost.estimatedCostUsd).toBeCloseTo(0.725, 3);
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
