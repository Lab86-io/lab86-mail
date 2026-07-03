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
import { classifyModel, toDirectModelId, toOpenRouterModelId } from './model-router';

type AiProvider = 'openrouter' | 'openai' | 'anthropic';
type AiSource = 'lab86' | 'byok';
type AiSpeed = 'fast' | 'primary' | 'nano';

// Progressive output ceilings, sized to the job. An UNSET cap makes the
// provider assume the model's max (65536) and OpenRouter reserves credits for
// that worst case — 402-ing valid requests. These keep each feature bounded
// (cheaper, faster) while leaving room for reasoning. Callers may still pass an
// explicit maxOutputTokens to override.
const FEATURE_MAX_TOKENS: Record<string, number> = {
  summarize_thread: 1500,
  triage_thread: 1500,
  daily_report_insight: 1500,
  daily_report_narrative: 4000,
  daily_report_artifact: 32000,
  albatross_plan: 8000,
  albatross_plan_artifact: 24000,
  albatross_place: 2000,
  albatross_local: 300,
  agent: 12000,
};
const DEFAULT_GENERATE_MAX_TOKENS = 4000;
const DEFAULT_STREAM_MAX_TOKENS = 24000;
const TRANSIENT_GENERATE_RETRY_DELAY_MS = 450;
// Cross-provider fallback chain: an outage at one provider (e.g. OpenAI's
// "server had an error" storms) must not take the agent down, so the chain
// spans vendors. Each id is routed to its best available key (direct or
// OpenRouter) at use time.
const DEFAULT_AGENT_FALLBACKS = [
  'anthropic/claude-sonnet-4.6',
  'anthropic/claude-haiku-4.5',
  'openai/gpt-5.5',
  'openai/gpt-5.4-mini',
];
// Features that get retry + cross-provider failover. The interactive agent AND
// the Daily Brief artifact both need it — a single provider blip on the brief
// was silently degrading it to the plain native renderer.
const FAILOVER_FEATURES = new Set(['agent', 'daily_report_artifact']);

function capForFeature(feature: string, explicit: number | undefined, fallback: number): number {
  return explicit ?? FEATURE_MAX_TOKENS[feature] ?? fallback;
}
type PlatformPreference = {
  provider?: AiProvider;
  modelName?: string;
};

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
// 'nano' is the bulk-classification tier: high-volume single-shot labeling
// (one LLM verdict per corpus thread) where per-token cost dominates. It
// always resolves to the platform default — user model preferences only steer
// the fast/primary tiers.
// The fast tier (which drives the agent and summaries) defaults to the
// nano model — gpt-5-nano on OpenRouter — per the operator's directive: fast
// should be nano-cheap everywhere unless an env override or BYOK setting raises it.
const DEFAULT_MODELS: Record<AiProvider, { primary: string; fast: string; nano: string }> = {
  openrouter: {
    primary: process.env.LAB86_MAIL_OPENAI_MODEL || process.env.MAIL_OS_OPENAI_MODEL || 'openai/gpt-5.5',
    fast:
      process.env.LAB86_MAIL_OPENAI_FAST_MODEL ||
      process.env.MAIL_OS_OPENAI_FAST_MODEL ||
      'openai/gpt-5-nano',
    nano: process.env.LAB86_MAIL_OPENAI_NANO_MODEL || 'openai/gpt-5-nano',
  },
  openai: {
    primary: process.env.LAB86_MAIL_OPENAI_MODEL || process.env.MAIL_OS_OPENAI_MODEL || 'gpt-5.5',
    fast: process.env.LAB86_MAIL_OPENAI_FAST_MODEL || process.env.MAIL_OS_OPENAI_FAST_MODEL || 'gpt-5-nano',
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
    userEmail?: string | null;
    userName?: string | null;
  },
) {
  const {
    feature = 'generate_text',
    speed = 'fast',
    userId,
    userEmail,
    userName,
    model: _ignored,
    maxOutputTokens,
    ...rest
  } = options as any;
  const runtime = await resolveAiRuntime({ userId, speed, feature });
  return runWithAiRequestContext({ userId: runtime.userId, userEmail, userName, agent: 'ai' }, async () => {
    let lastErr: any;
    const runtimes = [runtime, ...agentFallbackRuntimes(runtime, feature)];
    try {
      for (let runtimeIndex = 0; runtimeIndex < runtimes.length; runtimeIndex += 1) {
        const activeRuntime = runtimes[runtimeIndex];
        const maxAttempts = FAILOVER_FEATURES.has(feature) && runtimeIndex === 0 ? 2 : 1;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          try {
            const result = await generateText({
              ...rest,
              // Tiered ceiling by feature (see FEATURE_MAX_TOKENS) — never unbounded.
              maxOutputTokens: capForFeature(feature, maxOutputTokens, DEFAULT_GENERATE_MAX_TOKENS),
              model: activeRuntime.model,
            });
            await recordUsage(activeRuntime, feature, result.totalUsage ?? result.usage, true);
            return result;
          } catch (err: any) {
            lastErr = err;
            const canRetrySameModel = attempt < maxAttempts && isTransientGenerateParseError(err);
            const canTryFallback =
              runtimeIndex < runtimes.length - 1 && isAgentFallbackEligible(err, feature, activeRuntime);
            if (canRetrySameModel) {
              console.warn('[ai-gateway] agent model failed; retrying', {
                provider: activeRuntime.provider,
                model: activeRuntime.modelName,
                attempt,
                error: summarizeAiError(err),
              });
              await sleep(TRANSIENT_GENERATE_RETRY_DELAY_MS * attempt);
              continue;
            }
            if (canTryFallback) {
              console.warn('[ai-gateway] agent model failed; trying fallback', {
                provider: activeRuntime.provider,
                model: activeRuntime.modelName,
                fallback: runtimes[runtimeIndex + 1]?.modelName,
                error: summarizeAiError(err),
              });
              break;
            }
            throw err;
          }
        }
      }
      throw lastErr;
    } catch (err: any) {
      await recordUsage(runtime, feature, undefined, false, err?.message);
      throw err;
    }
  });
}

function agentFallbackRuntimes(runtime: ResolvedAiRuntime, feature: string): ResolvedAiRuntime[] {
  if (!FAILOVER_FEATURES.has(feature) || runtime.source !== 'lab86') return [];
  const configured = [process.env.LAB86_MAIL_AGENT_FALLBACK_MODEL, ...DEFAULT_AGENT_FALLBACKS];
  // Dedup on the vendor-agnostic (direct) id: the primary's modelName may be
  // OpenRouter-prefixed ("openai/gpt-5.5") while routePlatformModel returns the
  // direct form ("gpt-5.5") when a direct key is set — comparing raw strings
  // would miss that and retry the same underlying model.
  const seen = new Set([toDirectModelId(runtime.modelName)]);
  const out: ResolvedAiRuntime[] = [];
  for (const name of configured) {
    const trimmed = name?.trim();
    if (!trimmed) continue;
    const routed = routePlatformModel(trimmed);
    const key = routed ? toDirectModelId(routed.modelName) : '';
    // Skip anything we can't route or already tried (incl. the primary model).
    if (!routed || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...runtime, provider: routed.provider, modelName: routed.modelName, model: routed.model });
  }
  return out;
}

function isTransientGenerateParseError(err: any) {
  return (
    err?.message === 'Invalid JSON response' &&
    (err?.statusCode == null || err.statusCode === 200 || err.statusCode >= 500)
  );
}

function isAgentFallbackEligible(err: any, feature: string, runtime: ResolvedAiRuntime) {
  // Eligible regardless of which provider the primary used — a direct OpenAI or
  // Anthropic primary should still fail over to the cross-provider chain.
  if (!FAILOVER_FEATURES.has(feature) || runtime.source !== 'lab86') return false;
  if (isTransientGenerateParseError(err)) return true;
  const statusCode = Number(err?.statusCode);
  if (Number.isFinite(statusCode) && (statusCode === 429 || statusCode >= 500)) return true;
  const body = typeof err?.responseBody === 'string' ? err.responseBody : '';
  return /Provider returned error|server had an error|temporarily unavailable|rate.?limit|code"?\s*:\s*502/i.test(
    body,
  );
}

function summarizeAiError(err: any) {
  return {
    name: err?.name,
    message: err?.message,
    statusCode: err?.statusCode,
    isRetryable: err?.isRetryable,
    responseBody: typeof err?.responseBody === 'string' ? err.responseBody.slice(0, 240) : undefined,
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    maxOutputTokens,
    onFinish,
    onError,
    ...rest
  } = options as any;
  const runtime = await resolveAiRuntime({ userId, speed, feature });
  return runWithAiRequestContext({ userId: runtime.userId, userEmail, userName, agent: 'ai' }, () =>
    streamText({
      ...rest,
      // Tiered per-step ceiling (never unbounded → avoids the 65536 reservation
      // that OpenRouter 402s on); leaves room for reasoning + a reply.
      maxOutputTokens: capForFeature(feature, maxOutputTokens, DEFAULT_STREAM_MAX_TOKENS),
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

type RoutedModel = { provider: AiProvider; modelName: string; model: any };

// Route a model id to the best AVAILABLE provider for it: the model's own
// direct key (OpenAI key for OpenAI models, Anthropic key for Anthropic models)
// when configured — most reliable, no passthrough — otherwise OpenRouter as the
// universal catch-all. Translates the id between direct and OpenRouter forms.
function routePlatformModel(modelName: string): RoutedModel | null {
  const name = (modelName || '').trim();
  if (!name) return null;
  const vendor = classifyModel(name);
  if (vendor === 'openai' && openai) {
    const id = toDirectModelId(name);
    // .chat() = Chat Completions, the tool-call format the agent expects
    // (matches how models run via OpenRouter).
    return { provider: 'openai', modelName: id, model: openai.chat(id) };
  }
  if (vendor === 'anthropic' && anthropic) {
    const id = toDirectModelId(name);
    return { provider: 'anthropic', modelName: id, model: anthropic(id) };
  }
  if (openrouter) {
    const id = toOpenRouterModelId(name);
    return { provider: 'openrouter', modelName: id, model: openrouter.chat(id) };
  }
  // No OpenRouter — last resort is a direct key that can serve this vendor.
  if (vendor === 'openai' && openai) {
    const id = toDirectModelId(name);
    return { provider: 'openai', modelName: id, model: openai.chat(id) };
  }
  if (vendor === 'anthropic' && anthropic) {
    const id = toDirectModelId(name);
    return { provider: 'anthropic', modelName: id, model: anthropic(id) };
  }
  return null;
}

function platformRuntime(speed: AiSpeed, preference?: PlatformPreference): RoutedModel | null {
  if (isLab86AiDisabled()) return null;
  const requested = preference?.modelName?.trim();

  // An explicit provider preference with a matching configured key is honored
  // as the user chose it (BYOK-style platform preference).
  if (preference?.provider === 'openai' && openai) {
    const id = toDirectModelId(requested || modelFor('openai', speed));
    return { provider: 'openai', modelName: id, model: openai.chat(id) };
  }
  if (preference?.provider === 'anthropic' && anthropic) {
    const id = toDirectModelId(requested || modelFor('anthropic', speed));
    return { provider: 'anthropic', modelName: id, model: anthropic(id) };
  }
  if (preference?.provider === 'openrouter' && openrouter) {
    const id = toOpenRouterModelId(requested || modelFor('openrouter', speed));
    return { provider: 'openrouter', modelName: id, model: openrouter.chat(id) };
  }

  // Default path: take the configured model id (the canonical env defaults carry
  // vendor prefixes) and route it by vendor.
  const modelName = requested || modelFor('openrouter', speed);
  return routePlatformModel(modelName);
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
  if (speed === 'primary') return DEFAULT_MODELS[provider].primary;
  if (speed === 'nano') return DEFAULT_MODELS[provider].nano;
  return DEFAULT_MODELS[provider].fast;
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
