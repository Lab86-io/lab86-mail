import { NextRequest, NextResponse } from 'next/server';
import {
  B2C_ANNUAL_PRICE_USD,
  B2C_BYOK_ANNUAL_PRICE_USD,
  B2C_BYOK_MONTHLY_PRICE_USD,
  B2C_MONTHLY_PRICE_USD,
  resolveAiBudgetPolicy,
} from '@/lib/ai/budget';
import {
  normalizeOpenRouterFastModel,
  normalizeOpenRouterPrimaryModel,
  OPENROUTER_FAST_MODEL_OPTIONS,
  OPENROUTER_PRIMARY_MODEL_OPTIONS,
} from '@/lib/ai/model-options';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { getAiBillingEntitlement } from '@/lib/hosted/billing';
import {
  isLab86AiDisabled,
  isSubscriptionServiceDisabled,
  isUserOpenRouterKeyRequired,
} from '@/lib/hosted/controls';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';
import { encryptSecret, maskFingerprint, secretFingerprint } from '@/lib/security/crypto';

const PROVIDERS = new Set(['openrouter', 'openai', 'anthropic']);

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await requireCurrentUser().catch((err) => {
    if (err instanceof AuthRequiredError) return null;
    throw err;
  });
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Sign in required.' }, { status: 401 });
  }
  const state = await convexQuery<any>(api.ai.getRuntimeState, { userId: user.userId });
  const entitlement = await getAiBillingEntitlement();
  const requireOpenRouter = isUserOpenRouterKeyRequired();
  const monthlyCredits = requireOpenRouter ? 0 : entitlement.monthlyCredits;
  const creditsUsed = state.lab86Usage?.creditsUsed || 0;
  const budget = resolveAiBudgetPolicy({
    monthlyCredits,
    creditsUsed,
    feature: 'agent',
  });
  return NextResponse.json({
    ok: true,
    configured: true,
    settings: state.settings || {
      mode: requireOpenRouter ? 'byok' : 'lab86',
      provider: 'openrouter',
      enabled: true,
    },
    key: state.key
      ? {
          provider: state.key.provider,
          masked: state.key.masked,
          validatedAt: state.key.validatedAt,
        }
      : null,
    entitlement: {
      plan: entitlement.plan,
      status: entitlement.status,
      source: entitlement.source,
    },
    lab86AiDisabled: isLab86AiDisabled(),
    requiresUserOpenRouterKey: requireOpenRouter,
    subscriptionsDisabled: isSubscriptionServiceDisabled(),
    modelOptions: {
      openrouter: {
        primary: OPENROUTER_PRIMARY_MODEL_OPTIONS,
        fast: OPENROUTER_FAST_MODEL_OPTIONS,
      },
    },
    usage: {
      period: state.period,
      status: budget.hardStopped ? 'exhausted' : budget.softLimited ? 'reduced_cost' : 'available',
      paidPlan: {
        monthlyUsd: B2C_MONTHLY_PRICE_USD,
        annualUsd: B2C_ANNUAL_PRICE_USD,
        byokMonthlyUsd: B2C_BYOK_MONTHLY_PRICE_USD,
        byokAnnualUsd: B2C_BYOK_ANNUAL_PRICE_USD,
      },
    },
  });
}

export async function POST(req: NextRequest) {
  const user = await requireCurrentUser().catch((err) => {
    if (err instanceof AuthRequiredError) return null;
    throw err;
  });
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Sign in required.' }, { status: 401 });
  }
  try {
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'ai_settings_write',
      limit: 30,
      windowMs: 60_000,
    });
  } catch (err) {
    if (err instanceof RateLimitError) return rateLimitJson(err);
    throw err;
  }
  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid body');
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  if (body.mode !== undefined && body.mode !== 'byok' && body.mode !== 'lab86') {
    return NextResponse.json({ ok: false, error: 'mode must be byok or lab86' }, { status: 400 });
  }
  const mode = body.mode === 'byok' ? 'byok' : 'lab86';
  const provider =
    typeof body.provider === 'string' && PROVIDERS.has(body.provider) ? body.provider : undefined;
  if (mode === 'byok' && !provider) {
    return NextResponse.json({ ok: false, error: 'provider is required when mode is byok' }, { status: 400 });
  }
  let model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : undefined;
  const fastModel =
    typeof body.fastModel === 'string' && body.fastModel.trim() ? body.fastModel.trim() : undefined;
  let normalizedFastModel = fastModel;
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  if (apiKey.length > 4096) {
    return NextResponse.json({ ok: false, error: 'API key is too long' }, { status: 400 });
  }

  if (provider === 'openrouter') {
    model = normalizeOpenRouterPrimaryModel(model);
    normalizedFastModel = normalizeOpenRouterFastModel(fastModel);
  }

  if (provider === 'openai' || provider === 'anthropic') {
    model = undefined;
    normalizedFastModel = undefined;
  }

  // Fail at save time, not first use: BYOK is a paid-tier feature unless the
  // subscriptions-paused escape hatch below is active.
  if (mode === 'byok' && !isUserOpenRouterKeyRequired()) {
    const entitlement = await getAiBillingEntitlement().catch(() => null);
    if (entitlement && entitlement.plan === 'free') {
      return NextResponse.json(
        {
          ok: false,
          error: `Using your own API key requires the Lab86 Mail BYOK plan ($${B2C_BYOK_MONTHLY_PRICE_USD}/month) or Pro. Upgrade from the pricing page.`,
        },
        { status: 402 },
      );
    }
  }

  if (isUserOpenRouterKeyRequired()) {
    const existing = await convexQuery<any>(api.ai.getRuntimeState, { userId: user.userId }).catch(
      () => null,
    );
    if (mode !== 'byok' || provider !== 'openrouter') {
      return NextResponse.json(
        { ok: false, error: 'OpenRouter BYOK is required while Lab86 AI subscriptions are disabled.' },
        { status: 400 },
      );
    }
    if (!apiKey && existing?.key?.provider !== 'openrouter') {
      return NextResponse.json(
        { ok: false, error: 'Add an OpenRouter API key before saving AI settings.' },
        { status: 400 },
      );
    }
  }

  if (apiKey && !provider) {
    return NextResponse.json(
      { ok: false, error: 'provider is required when saving an API key' },
      { status: 400 },
    );
  }
  if (apiKey && provider === 'openrouter' && !apiKey.startsWith('sk-or-')) {
    return NextResponse.json(
      { ok: false, error: 'OpenRouter API keys must start with sk-or-' },
      { status: 400 },
    );
  }

  await convexMutation(api.users.upsertFromClerk, {
    userId: user.userId,
    email: user.email,
    name: user.name,
  });
  await convexMutation(api.ai.upsertSettings, {
    userId: user.userId,
    mode,
    provider,
    model,
    fastModel: normalizedFastModel,
    enabled: body.enabled !== false,
  });

  if (apiKey) {
    const fingerprint = secretFingerprint(apiKey);
    await convexMutation(api.ai.upsertProviderKey, {
      userId: user.userId,
      provider,
      encryptedKey: encryptSecret(apiKey),
      fingerprint,
      masked: maskFingerprint(fingerprint),
      validatedAt: Date.now(),
    });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const user = await requireCurrentUser().catch((err) => {
    if (err instanceof AuthRequiredError) return null;
    throw err;
  });
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Sign in required.' }, { status: 401 });
  }
  try {
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'ai_settings_delete',
      limit: 30,
      windowMs: 60_000,
    });
  } catch (err) {
    if (err instanceof RateLimitError) return rateLimitJson(err);
    throw err;
  }
  const url = new URL(req.url);
  const provider = url.searchParams.get('provider') || '';
  if (!PROVIDERS.has(provider)) {
    return NextResponse.json({ ok: false, error: 'valid provider is required' }, { status: 400 });
  }
  await convexMutation(api.ai.deleteProviderKey, { userId: user.userId, provider });
  return NextResponse.json({ ok: true });
}
