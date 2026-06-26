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
