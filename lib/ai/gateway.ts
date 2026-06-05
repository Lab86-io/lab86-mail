import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, type ModelMessage, streamText } from 'ai';
import { getAiBillingEntitlement } from '@/lib/hosted/billing';
import { isLab86AiDisabled, isUserOpenRouterKeyRequired } from '@/lib/hosted/controls';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { aiCreditDefaults, isConvexConfigured } from '@/lib/hosted/env';
import { decryptSecret } from '@/lib/security/crypto';
import { anthropic, openai, openrouter } from './client';
import { getAiRequestContext, runWithAiRequestContext } from './context';

type AiProvider = 'openrouter' | 'openai' | 'anthropic';
type AiSource = 'lab86' | 'byok' | 'legacy';
type AiSpeed = 'fast' | 'primary';
type PlatformPreference = {
  provider?: AiProvider;
  modelName?: string;
};

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MODELS: Record<AiProvider, { primary: string; fast: string }> = {
  openrouter: {
    primary: process.env.LAB86_MAIL_OPENAI_MODEL || process.env.MAIL_OS_OPENAI_MODEL || 'openai/gpt-5.5',
    fast:
      process.env.LAB86_MAIL_OPENAI_FAST_MODEL ||
      process.env.MAIL_OS_OPENAI_FAST_MODEL ||
      'openai/gpt-5.4-mini',
  },
  openai: {
    primary: process.env.LAB86_MAIL_OPENAI_MODEL || process.env.MAIL_OS_OPENAI_MODEL || 'gpt-5.5',
    fast: process.env.LAB86_MAIL_OPENAI_FAST_MODEL || process.env.MAIL_OS_OPENAI_FAST_MODEL || 'gpt-5.5-mini',
  },
  anthropic: {
    primary: process.env.LAB86_MAIL_ANTHROPIC_MODEL || 'claude-sonnet-4-6',
    fast: process.env.LAB86_MAIL_ANTHROPIC_FAST_MODEL || 'claude-haiku-4-5-20251001',
  },
};

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
  const speed = input.speed || 'fast';
  let platformPreference: PlatformPreference | undefined;

  if (userId && isConvexConfigured()) {
    const state = await convexQuery<RuntimeState>(api.ai.getRuntimeState, { userId });
    const mode = state.settings?.enabled === false ? 'lab86' : state.settings?.mode || 'lab86';
    if (isUserOpenRouterKeyRequired()) {
      if (state.key?.provider === 'openrouter') {
        const apiKey = decryptSecret(state.key.encryptedKey);
        const modelName =
          (speed === 'fast' ? state.settings?.fastModel : state.settings?.model) ||
          modelFor('openrouter', speed);
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
      const apiKey = decryptSecret(state.key.encryptedKey);
      const provider = state.key.provider;
      const modelName =
        (speed === 'fast' ? state.settings?.fastModel : state.settings?.model) || modelFor(provider, speed);
      return {
        userId,
        source: 'byok',
        provider,
        modelName,
        model: modelFromKey(provider, apiKey, modelName),
      };
    }

    const entitlement = await getAiBillingEntitlement();
    assertLab86Quota(state, entitlement);
    platformPreference = {
      provider: state.settings?.provider,
      modelName: speed === 'fast' ? state.settings?.fastModel : state.settings?.model,
    };
  }

  if (isUserOpenRouterKeyRequired()) {
    throw new Error('Sign in and add your OpenRouter API key before using AI features.');
  }

  const platform = platformRuntime(speed, platformPreference);
  if (platform) {
    return {
      userId,
      source: userId ? 'lab86' : 'legacy',
      ...platform,
    };
  }
  throw new Error(
    'No AI provider configured. Add a user API key or configure OPENROUTER_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY.',
  );
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
    messages: ModelMessage[];
  },
) {
  const {
    feature = 'agent',
    speed = 'fast',
    userId,
    userEmail,
    model: _ignored,
    onFinish,
    onError,
    ...rest
  } = options as any;
  const runtime = await resolveAiRuntime({ userId, speed, feature });
  return runWithAiRequestContext({ userId: runtime.userId, userEmail }, () =>
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

function assertLab86Quota(
  state: RuntimeState,
  clerkEntitlement?: { monthlyCredits: number; status: string } | null,
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
  if (monthlyCredits <= 0 || used >= monthlyCredits) {
    throw new Error('Lab86 AI quota is exhausted. Upgrade your plan or switch to your own API key.');
  }
}

async function recordUsage(
  runtime: ResolvedAiRuntime,
  feature: string,
  usage: any,
  ok: boolean,
  error?: string,
) {
  if (!runtime.userId || !isConvexConfigured()) return;
  const promptTokens = numericUsage(usage?.inputTokens ?? usage?.promptTokens);
  const completionTokens = numericUsage(usage?.outputTokens ?? usage?.completionTokens);
  const totalTokens = numericUsage(usage?.totalTokens) ?? (promptTokens || 0) + (completionTokens || 0);
  await convexMutation(api.ai.recordUsage, {
    userId: runtime.userId,
    feature,
    source: runtime.source,
    provider: runtime.provider,
    model: runtime.modelName,
    promptTokens,
    completionTokens,
    totalTokens,
    estimatedCredits: Math.max(1, totalTokens || 1),
    ok,
    error,
  }).catch(() => undefined);
}

function numericUsage(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
