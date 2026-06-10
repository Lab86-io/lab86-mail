export type AiProvider = 'openrouter' | 'openai' | 'anthropic';

export const B2C_MONTHLY_PRICE_USD = 15;
export const B2C_ANNUAL_PRICE_USD = 120;
export const B2C_INTERNAL_MONTHLY_CREDITS = 500;
export const AI_CREDIT_VALUE_USD = 0.01;
export const AI_BUDGET_SOFT_LIMIT_RATIO = 0.8;

export interface AiUsageCostInput {
  provider: AiProvider;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  batch?: boolean;
}

export interface AiBudgetPolicyInput {
  feature: string;
  monthlyCredits: number;
  creditsUsed: number;
}

export function estimateAiUsageCost(input: AiUsageCostInput) {
  const rates = ratesForModel(input.provider, input.model);
  const promptTokens = nonnegative(input.promptTokens);
  const completionTokens = nonnegative(input.completionTokens);
  const cachedInputTokens = Math.min(nonnegative(input.cachedInputTokens), promptTokens);
  const cacheWriteTokens = Math.min(nonnegative(input.cacheWriteTokens), promptTokens - cachedInputTokens);
  const standardInputTokens = Math.max(0, promptTokens - cachedInputTokens - cacheWriteTokens);
  const discount = input.batch ? 0.5 : 1;
  const estimatedCostUsd =
    ((standardInputTokens * rates.inputUsdPerMTok +
      cachedInputTokens * rates.cachedInputUsdPerMTok +
      cacheWriteTokens * rates.cacheWriteUsdPerMTok +
      completionTokens * rates.outputUsdPerMTok) /
      1_000_000) *
    discount;
  return {
    estimatedCostUsd,
    estimatedCredits: roundCredits(estimatedCostUsd / AI_CREDIT_VALUE_USD),
    rates,
  };
}

export function resolveAiBudgetPolicy(input: AiBudgetPolicyInput) {
  const monthlyCredits = Math.max(0, input.monthlyCredits);
  const creditsUsed = Math.max(0, input.creditsUsed);
  const ratio = monthlyCredits > 0 ? creditsUsed / monthlyCredits : 1;
  const subscribed = monthlyCredits > 0;
  const softLimited = subscribed && ratio >= AI_BUDGET_SOFT_LIMIT_RATIO;
  const exhausted = subscribed && creditsUsed >= monthlyCredits;
  const chat = isAiChatFeature(input.feature);
  return {
    subscribed,
    ratio,
    softLimited,
    exhausted,
    forceFastModel: softLimited || exhausted,
    hardStopped: !subscribed || (chat && exhausted),
    chat,
  };
}

export function isAiChatFeature(feature: string) {
  return feature === 'agent' || feature === 'chat';
}

export function shouldDepleteLab86Budget(source: 'lab86' | 'byok') {
  return source === 'lab86';
}

function ratesForModel(provider: AiProvider, model: string) {
  const normalized = model.toLowerCase();
  if (provider === 'anthropic' || normalized.includes('anthropic/') || normalized.includes('claude')) {
    if (normalized.includes('haiku')) {
      return rate(1, 0.1, 1.25, 5);
    }
    if (normalized.includes('opus')) {
      return rate(5, 0.5, 6.25, 25);
    }
    return rate(3, 0.3, 3.75, 15);
  }

  const openaiModel = normalized.replace(/^openai\//, '');
  if (openaiModel.includes('pro')) return rate(30, 3, 30, 180);
  if (openaiModel.includes('nano')) return rate(0.1, 0.01, 0.1, 0.625);
  if (openaiModel.includes('mini')) return rate(0.375, 0.0375, 0.375, 2.25);
  if (openaiModel.includes('gpt-5.4')) return rate(2.5, 0.25, 2.5, 15);
  if (openaiModel.includes('gpt-5.5')) return rate(5, 0.5, 5, 30);

  return rate(3, 0.3, 3.75, 15);
}

function rate(
  inputUsdPerMTok: number,
  cachedInputUsdPerMTok: number,
  cacheWriteUsdPerMTok: number,
  outputUsdPerMTok: number,
) {
  return { inputUsdPerMTok, cachedInputUsdPerMTok, cacheWriteUsdPerMTok, outputUsdPerMTok };
}

function nonnegative(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function roundCredits(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.ceil(value * 100) / 100;
}
