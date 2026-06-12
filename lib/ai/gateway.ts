import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, type ModelMessage, streamText } from 'ai';
import { getAiBillingEntitlement } from '@/lib/hosted/billing';
import { isLab86AiDisabled, isUserOpenRouterKeyRequired } from '@/lib/hosted/controls';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { aiCreditDefaults } from '@/lib/hosted/env';
import { decryptSecret } from '@/lib/security/crypto';
import {
  B2C_BYOK_MONTHLY_PRICE_USD,
  estimateAiUsageCost,
  resolveAiBudgetPolicy,
  shouldDepleteLab86Budget,
} from './budget';
import { anthropic, openai, openrouter } from './client';
import { getAiRequestContext, runWithAiRequestContext } from './context';

type AiProvider = 'openrouter' | 'openai' | 'anthropic';
type AiSource = 'lab86' | 'byok';
type AiSpeed = 'fast' | 'primary' | 'nano';
type PlatformPreference = {
  provider?: AiProvider;
  modelName?: string;
};

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
// 'nano' is the bulk-classification tier: high-volume single-shot labeling
// (one LLM verdict per corpus thread) where per-token cost dominates. It
// always resolves to the platform default — user model preferences only steer
// the fast/primary tiers.
const DEFAULT_MODELS: Record<AiProvider, { primary: string; fast: string; nano: string }> = {
  openrouter: {
    primary: process.env.LAB86_MAIL_OPENAI_MODEL || process.env.MAIL_OS_OPENAI_MODEL || 'openai/gpt-5.5',
    fast:
      process.env.LAB86_MAIL_OPENAI_FAST_MODEL ||
      process.env.MAIL_OS_OPENAI_FAST_MODEL ||
      'openai/gpt-5.4-mini',
    nano: process.env.LAB86_MAIL_OPENAI_NANO_MODEL || 'openai/gpt-5.4-nano',
  },
  openai: {
    primary: process.env.LAB86_MAIL_OPENAI_MODEL || process.env.MAIL_OS_OPENAI_MODEL || 'gpt-5.5',
    fast: process.env.LAB86_MAIL_OPENAI_FAST_MODEL || process.env.MAIL_OS_OPENAI_FAST_MODEL || 'gpt-5.5-mini',
    nano: process.env.LAB86_MAIL_OPENAI_NANO_MODEL || 'gpt-5-nano',
  },
  anthropic: {
    primary: process.env.LAB86_MAIL_ANTHROPIC_MODEL || 'claude-sonnet-4-6',
    fast: process.env.LAB86_MAIL_ANTHROPIC_FAST_MODEL || 'claude-haiku-4-5-20251001',
    nano: process.env.LAB86_MAIL_ANTHROPIC_FAST_MODEL || 'claude-haiku-4-5-20251001',
  },
};

// User model overrides apply to fast/primary only; nano stays on the cheap
// platform default so a bulk sweep can never burn the user's premium model.
function settingsModelFor(speed: AiSpeed, settings?: RuntimeState['settings'] | null) {
  if (speed === 'nano') return undefined;
  return speed === 'fast' ? settings?.fastModel : settings?.model;
}

interface RuntimeState {
  settings?: {
    mode: 'lab86' | 'byok';
    provider?: AiProvider;
    model?: string;
    fastModel?: string;
    enabled: boolean;
  } | null;
  key?: {
    provider: AiProvider;
    encryptedKey: string;
  } | null;
  entitlement?: {
    plan: 'free' | 'pro' | 'admin';
    status: 'inactive' | 'active' | 'trialing' | 'past_due' | 'canceled';
    monthlyCredits: number;
  } | null;
  lab86Usage?: {
    creditsUsed: number;
  } | null;
  period: string;
}

interface ResolvedAiRuntime {
  userId: string | null;
  source: AiSource;
  provider: AiProvider;
  modelName: string;
  model: any;
}

export function hasPlatformAi() {
  return Boolean(openrouter || openai || anthropic);
}

export async function resolveAiRuntime(input: {
  userId?: string | null;
  speed?: AiSpeed;
  feature: string;
}): Promise<ResolvedAiRuntime> {
  const userId = input.userId || getAiRequestContext().userId || null;
  let speed = input.speed || 'fast';
  let platformPreference: PlatformPreference | undefined;

  if (userId) {
    const state = await convexQuery<RuntimeState>(api.ai.getRuntimeState, { userId });
    const mode = state.settings?.enabled === false ? 'lab86' : state.settings?.mode || 'lab86';
    if (isUserOpenRouterKeyRequired()) {
      if (state.key?.provider === 'openrouter') {
        const apiKey = decryptSecret(state.key.encryptedKey);
        const modelName = settingsModelFor(speed, state.settings) || modelFor('openrouter', speed);
        return {
          userId,
          source: 'byok',
          provider: 'openrouter',
          modelName,
          model: modelFromKey('openrouter', apiKey, modelName),
        };
      }
      throw new Error('Add your OpenRouter API key in Accounts and AI before using AI features.');
    }
    if (mode === 'byok' && state.key) {
      // BYOK AI is part of the paid tiers ($5 BYOK or $15 Pro). The
      // subscriptions-paused escape hatch above stays unmetered.
      const entitlement = await getAiBillingEntitlement().catch(() => null);
      if (entitlement && entitlement.plan === 'free') {
        throw new Error(
          `Using your own API key requires the Lab86 Mail BYOK plan ($${B2C_BYOK_MONTHLY_PRICE_USD}/month) or Pro. Upgrade from Settings.`,
        );
      }
      const apiKey = decryptSecret(state.key.encryptedKey);
      const provider = state.key.provider;
      const modelName = settingsModelFor(speed, state.settings) || modelFor(provider, speed);
      return {
        userId,
        source: 'byok',
        provider,
        modelName,
        model: modelFromKey(provider, apiKey, modelName),
      };
    }

    const entitlement = await getAiBillingEntitlement();
    const budgetPolicy = assertLab86Budget(state, entitlement, input.feature);
    if (budgetPolicy.forceFastModel && speed === 'primary') speed = 'fast';
    platformPreference = {
      provider: state.settings?.provider,
      modelName: settingsModelFor(speed, state.settings),
    };
  }

  if (isUserOpenRouterKeyRequired()) {
    throw new Error('Sign in and add your OpenRouter API key before using AI features.');
  }

  const platform = platformRuntime(speed, platformPreference);
  if (platform) {
    return {
      userId,
      source: 'lab86',
      ...platform,
    };
  }
  throw new Error(
    'No AI provider configured. Add a user API key or configure OPENROUTER_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY.',
  );
}

// User-aware availability check: true when the current user can reach a model
// through ANY source (their own BYOK key, or platform keys within budget).
// Unlike the env-only hasAi() in lib/ai/client.ts, this does not break
// BYOK-only deployments with no platform key.
export async function hasAiForCurrentUser(feature = 'availability_check'): Promise<boolean> {
  try {
    await resolveAiRuntime({ feature });
    return true;
  } catch {
    return false;
  }
}

export async function generateTextForCurrentUser(
  options: Record<string, any> & {
    feature?: string;
    speed?: AiSpeed;
    userId?: string | null;
  },
) {
  const { feature = 'generate_text', speed = 'fast', userId, model: _ignored, ...rest } = options as any;
  const runtime = await resolveAiRuntime({ userId, speed, feature });
  try {
    const result = await generateText({
      ...rest,
      model: runtime.model,
    });
    await recordUsage(runtime, feature, result.usage, true);
    return result;
  } catch (err: any) {
    await recordUsage(runtime, feature, undefined, false, err?.message);
    throw err;
  }
}

export async function streamTextForUser(
  options: Record<string, any> & {
    feature?: string;
    speed?: AiSpeed;
    userId?: string | null;
    userEmail?: string | null;
    userName?: string | null;
    messages: ModelMessage[];
  },
) {
  const {
    feature = 'agent',
    speed = 'fast',
    userId,
    userEmail,
    userName,
    model: _ignored,
    onFinish,
    onError,
    ...rest
  } = options as any;
  const runtime = await resolveAiRuntime({ userId, speed, feature });
  return runWithAiRequestContext({ userId: runtime.userId, userEmail, userName, agent: 'ai' }, () =>
    streamText({
      ...rest,
      model: runtime.model,
      onFinish: async (event) => {
        await recordUsage(runtime, feature, event.usage, true);
        await onFinish?.(event);
      },
      onError: async (event) => {
        await recordUsage(runtime, feature, undefined, false, String(event.error || 'stream failed'));
        await onError?.(event);
      },
    }),
  );
}

function platformRuntime(speed: AiSpeed, preference?: PlatformPreference) {
  if (isLab86AiDisabled()) return null;
  const requestedModel = preference?.modelName?.trim();
  if (
    requestedModel &&
    openrouter &&
    (preference?.provider === 'openrouter' || requestedModel.includes('/'))
  ) {
    return {
      provider: 'openrouter' as const,
      modelName: requestedModel,
      model: openrouter.chat(requestedModel),
    };
  }
  if (preference?.provider === 'openai' && openai) {
    const modelName = requestedModel || modelFor('openai', speed);
    return { provider: 'openai' as const, modelName, model: openai(modelName) };
  }
  if (preference?.provider === 'anthropic' && anthropic) {
    const modelName = requestedModel || modelFor('anthropic', speed);
    return { provider: 'anthropic' as const, modelName, model: anthropic(modelName) };
  }
  if (preference?.provider === 'openrouter' && openrouter) {
    const modelName = requestedModel || modelFor('openrouter', speed);
    return { provider: 'openrouter' as const, modelName, model: openrouter.chat(modelName) };
  }
  if (openrouter) {
    const modelName = modelFor('openrouter', speed);
    return { provider: 'openrouter' as const, modelName, model: openrouter.chat(modelName) };
  }
  if (openai) {
    const modelName = modelFor('openai', speed);
    return { provider: 'openai' as const, modelName, model: openai(modelName) };
  }
  if (anthropic) {
    const modelName = modelFor('anthropic', speed);
    return { provider: 'anthropic' as const, modelName, model: anthropic(modelName) };
  }
  return null;
}

function modelFromKey(provider: AiProvider, apiKey: string, modelName: string) {
  if (provider === 'openrouter') {
    return createOpenAI({
      apiKey,
      baseURL: OPENROUTER_BASE_URL,
      headers: {
        'HTTP-Referer': process.env.LAB86_MAIL_PUBLIC_URL || 'https://mail.lab86.io',
        'X-Title': 'lab86-mail',
      },
    }).chat(modelName);
  }
  if (provider === 'openai') return createOpenAI({ apiKey })(modelName);
  return createAnthropic({ apiKey })(modelName);
}

function modelFor(provider: AiProvider, speed: AiSpeed) {
  return speed === 'primary' ? DEFAULT_MODELS[provider].primary : DEFAULT_MODELS[provider].fast;
}

function assertLab86Budget(
  state: RuntimeState,
  clerkEntitlement?: { monthlyCredits: number; status: string } | null,
  feature = 'agent',
) {
  if (isLab86AiDisabled()) {
    throw new Error('Lab86 AI is temporarily disabled. Switch to your own API key to continue.');
  }
  const defaults = aiCreditDefaults();
  const entitlement = clerkEntitlement || state.entitlement;
  const monthlyCredits =
    entitlement && (entitlement.status === 'active' || entitlement.status === 'trialing')
      ? entitlement.monthlyCredits
      : defaults.freeMonthlyCredits;
  const used = state.lab86Usage?.creditsUsed || 0;
  const policy = resolveAiBudgetPolicy({ monthlyCredits, creditsUsed: used, feature });
  if (!policy.subscribed) {
    throw new Error('Choose the Lab86 Mail paid plan or switch to your own API key before using Lab86 AI.');
  }
  if (policy.hardStopped) {
    throw new Error(
      'Lab86 AI chat budget is exhausted for this month. Core mail automation will continue in reduced-cost mode, or you can switch to your own API key.',
    );
  }
  return policy;
}

async function recordUsage(
  runtime: ResolvedAiRuntime,
  feature: string,
  usage: any,
  ok: boolean,
  error?: string,
) {
  if (!runtime.userId) return;
  const promptTokens = numericUsage(usage?.inputTokens ?? usage?.promptTokens);
  const completionTokens = numericUsage(usage?.outputTokens ?? usage?.completionTokens);
  const totalTokens = numericUsage(usage?.totalTokens) ?? (promptTokens || 0) + (completionTokens || 0);
  const cachedInputTokens = numericUsage(
    usage?.cachedInputTokens ??
      usage?.promptTokensDetails?.cachedTokens ??
      usage?.inputTokensDetails?.cachedTokens ??
      usage?.inputTokensDetails?.cachedInputTokens,
  );
  const cacheWriteTokens = numericUsage(
    usage?.cacheWriteTokens ??
      usage?.promptTokensDetails?.cacheCreationTokens ??
      usage?.inputTokensDetails?.cacheCreationTokens,
  );
  const cost = estimateAiUsageCost({
    provider: runtime.provider,
    model: runtime.modelName,
    promptTokens,
    completionTokens,
    cachedInputTokens,
    cacheWriteTokens,
    batch: Boolean(usage?.batch || usage?.batchMode),
  });
  await convexMutation(api.ai.recordUsage, {
    userId: runtime.userId,
    feature,
    source: runtime.source,
    provider: runtime.provider,
    model: runtime.modelName,
    promptTokens,
    completionTokens,
    totalTokens,
    estimatedCredits: shouldDepleteLab86Budget(runtime.source) ? cost.estimatedCredits : 0,
    ok,
    error,
  }).catch(() => undefined);
}

function numericUsage(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
