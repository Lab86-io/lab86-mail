import { classifierForServedModel } from '../classifier/catalog';
import { PAID_PLANS } from '../hosted/plans';

export type AiProvider = 'openrouter' | 'openai' | 'anthropic';

// Prices come from the one source of truth in lib/hosted/plans.ts.
// Pro: Lab86 pays for the models, with no credit limit (see `unlimited`).
export const B2C_MONTHLY_PRICE_USD = PAID_PLANS.pro.monthlyUsd;
export const B2C_ANNUAL_PRICE_USD = PAID_PLANS.pro.annualUsd;
// Own key: full feature set, user supplies their own model API key.
export const B2C_BYOK_MONTHLY_PRICE_USD = PAID_PLANS.byok.monthlyUsd;
export const B2C_BYOK_ANNUAL_PRICE_USD = PAID_PLANS.byok.annualUsd;
export const B2C_INTERNAL_MONTHLY_CREDITS = 500;
export const AI_CREDIT_VALUE_USD = 0.01;
export const AI_BUDGET_SOFT_LIMIT_RATIO = 0.8;

export interface AiUsageCostInput {
  provider: AiProvider | 'together';
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  batch?: boolean;
  /**
   * The cost the provider reported for the call, in USD (OpenRouter
   * `usage.cost`). When present it replaces the price-table estimate.
   */
  costUsd?: number;
}

export interface AiBudgetPolicyInput {
  feature: string;
  monthlyCredits: number;
  creditsUsed: number;
  /**
   * The plan has no credit limit: Pro, the Pro trial, and admin with no
   * explicit limit (lib/hosted/billing.ts `planHasNoCreditLimit`). The policy
   * then never stops a call and never moves it to a cheaper model, and
   * `monthlyCredits` does not apply. Usage is still recorded.
   */
  unlimited?: boolean;
}

export function estimateAiUsageCost(input: AiUsageCostInput) {
  const rates = ratesForModel(input.provider, input.model);
  const promptTokens = nonnegative(input.promptTokens);
  const completionTokens = nonnegative(input.completionTokens);
  const cachedInputTokens = Math.min(nonnegative(input.cachedInputTokens), promptTokens);
  const cacheWriteTokens = Math.min(nonnegative(input.cacheWriteTokens), promptTokens - cachedInputTokens);
  const standardInputTokens = Math.max(0, promptTokens - cachedInputTokens - cacheWriteTokens);
  const discount = input.batch ? 0.5 : 1;
  const tableCostUsd =
    ((standardInputTokens * rates.inputUsdPerMTok +
      cachedInputTokens * rates.cachedInputUsdPerMTok +
      cacheWriteTokens * rates.cacheWriteUsdPerMTok +
      completionTokens * rates.outputUsdPerMTok) /
      1_000_000) *
    discount;
  const reported = reportedCost(input.costUsd);
  const estimatedCostUsd = reported ?? tableCostUsd;
  return {
    estimatedCostUsd,
    estimatedCredits: roundCredits(estimatedCostUsd / AI_CREDIT_VALUE_USD),
    rates,
    reported: reported !== undefined,
  };
}

/**
 * The cost OpenRouter reported for a generateText or generateObject result,
 * in USD: the sum of `usage.cost` in each step's raw response body.
 * Undefined when a step has no reported cost (a direct vendor key, or a
 * provider that sends no cost); the caller then uses the price table.
 */
export function providerReportedCostUsd(result: unknown): number | undefined {
  const value = result as { steps?: unknown[]; response?: { body?: any } } | null | undefined;
  const steps = Array.isArray(value?.steps) && value.steps.length ? value.steps : [value];
  let total = 0;
  for (const step of steps as Array<{ response?: { body?: any } } | null | undefined>) {
    const cost = reportedCost(step?.response?.body?.usage?.cost);
    if (cost === undefined) return undefined;
    total += cost;
  }
  return total;
}

function reportedCost(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export const BRIEF_GENERATION_FEATURES = new Set([
  'daily_report_insight',
  'daily_report_narrative',
  'daily_report_artifact',
  'daily_brief_prose',
  'daily_brief_layout',
  'albatross_area_pulse',
  'albatross_area_artifact',
  'narrative_workspace',
  'narrative_retrieval',
  'narrative_research',
  'narrative_write',
  'narrative_meeting_prep',
]);

export function resolveAiBudgetPolicy(input: AiBudgetPolicyInput) {
  const chat = isAiChatFeature(input.feature);
  if (input.unlimited)
    return {
      subscribed: true,
      unlimited: true,
      ratio: 0,
      softLimited: false,
      exhausted: false,
      forceFastModel: false,
      hardStopped: false,
      chat,
    };
  const monthlyCredits = Math.max(0, input.monthlyCredits);
  const creditsUsed = Math.max(0, input.creditsUsed);
  const ratio = monthlyCredits > 0 ? creditsUsed / monthlyCredits : 1;
  const subscribed = monthlyCredits > 0;
  const softLimited = subscribed && ratio >= AI_BUDGET_SOFT_LIMIT_RATIO;
  const exhausted = subscribed && creditsUsed >= monthlyCredits;
  return {
    subscribed,
    unlimited: false,
    ratio,
    softLimited,
    exhausted,
    forceFastModel: (softLimited || exhausted) && !BRIEF_GENERATION_FEATURES.has(input.feature),
    hardStopped: !subscribed || (chat && exhausted),
    chat,
  };
}

/**
 * The policy for a live or stored entitlement. An entitlement that is not
 * active or trialing gets the Free limit. `unlimited` (Pro) applies only to a
 * current entitlement.
 */
export function resolveEntitlementBudgetPolicy(input: {
  entitlement: { monthlyCredits: number; status: string; unlimited?: boolean } | null | undefined;
  freeMonthlyCredits: number;
  creditsUsed: number;
  feature: string;
}) {
  const entitlement = input.entitlement;
  const current = entitlement?.status === 'active' || entitlement?.status === 'trialing';
  return resolveAiBudgetPolicy({
    feature: input.feature,
    monthlyCredits: current ? entitlement.monthlyCredits : input.freeMonthlyCredits,
    creditsUsed: input.creditsUsed,
    unlimited: current && entitlement.unlimited === true,
  });
}

/**
 * Agent turns the user asked for: chat, and step runs the user started
 * (`albatross_step`). They stop when the month's credits run out. Automatic
 * step runs (`albatross_step_auto`) are background work.
 */
export function isAiChatFeature(feature: string) {
  return feature === 'agent' || feature === 'chat' || feature === 'albatross_step';
}

export function shouldDepleteLab86Budget(source: 'lab86' | 'byok') {
  return source === 'lab86';
}

// OpenRouter list prices in USD per million tokens (input, cache read, cache
// write, output), checked 2026-09-27. The key is the id with no vendor prefix
// and with dots in the version (a direct Anthropic id uses dashes).
const LISTED_RATES: Record<string, ReturnType<typeof rate>> = {
  'glm-5.3-flash': rate(0.15, 0.03, 0.15, 0.5),
  'gpt-5.6-luna': rate(0.2, 0.02, 0.25, 1.2),
  'gpt-5.6-terra': rate(2, 0.2, 2.5, 12),
  'gpt-5.4-mini': rate(0.75, 0.075, 0.75, 4.5),
  'gemini-2.5-flash-lite': rate(0.1, 0.01, 0.0833, 0.4),
  'claude-opus-5.5': rate(4, 0.2, 5, 20),
};

function ratesForModel(provider: AiUsageCostInput['provider'], model: string) {
  const normalized = model.toLowerCase().split(':')[0];
  const listed = LISTED_RATES[normalized.replace(/^[^/]+\//, '').replace(/(\d)-(\d)/g, '$1.$2')];
  if (listed) return listed;
  const classifier = classifierForServedModel(normalized);
  if (classifier)
    return rate(classifier.inputPerMillion, classifier.inputPerMillion, classifier.inputPerMillion, 0);
  if (normalized === 'openai/text-embedding-3-small') return rate(0.02, 0.02, 0.02, 0);
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

// Credits keep six decimals. A round-up to 0.01 credit on each call made a
// cheap call (a Jev verdict or an embedding) count up to twice its cost.
function roundCredits(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * 1_000_000) / 1_000_000;
}
