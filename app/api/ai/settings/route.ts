import { NextRequest, NextResponse } from 'next/server';
import {
  B2C_ANNUAL_PRICE_USD,
  B2C_BYOK_ANNUAL_PRICE_USD,
  B2C_BYOK_MONTHLY_PRICE_USD,
  B2C_MONTHLY_PRICE_USD,
  resolveAiBudgetPolicy,
} from '@/lib/ai/budget';
import {
  buildModelCatalog,
  catalogProviderFor,
  defaultModelsFor,
  loadModelCatalog,
  providersAvailableFor,
  savedModelSummary,
  validateModelChoice,
} from '@/lib/ai/model-catalog';
import {
  fetchOpenRouterCatalog,
  OPENROUTER_DEFAULT_FAST_MODEL,
  OPENROUTER_DEFAULT_PRIMARY_MODEL,
  openRouterModelOptionsFrom,
  type Provider,
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
  const fetched = await fetchOpenRouterCatalog().catch((err) => {
    console.error('[ai-settings] failed to load OpenRouter model options', err);
    return { data: [], live: false };
  });
  const openrouterModelOptions = openRouterModelOptionsFrom(fetched);
  const settings = state.settings || {
    mode: requireOpenRouter ? 'byok' : 'lab86',
    provider: 'openrouter',
    model: OPENROUTER_DEFAULT_PRIMARY_MODEL,
    fastModel: OPENROUTER_DEFAULT_FAST_MODEL,
    enabled: true,
  };
  const catalogProvider = catalogProviderFor(settings, state.key?.provider);
  const catalog = buildModelCatalog({ live: fetched.live ? fetched.data : null, provider: catalogProvider });
  const budget = resolveAiBudgetPolicy({
    monthlyCredits,
    creditsUsed,
    feature: 'agent',
  });
  return NextResponse.json({
    ok: true,
    configured: true,
    settings,
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
        primary: openrouterModelOptions.primary,
        fast: openrouterModelOptions.fast,
        live: openrouterModelOptions.live,
      },
    },
    catalog,
    catalogLive: fetched.live,
    catalogProvider,
    providersAvailable: providersAvailableFor(catalogProvider),
    defaults: defaultModelsFor(catalogProvider),
    savedModels: {
      normal: savedModelSummary(settings.model, catalog, catalogProvider),
      fast: savedModelSummary(settings.fastModel, catalog, catalogProvider),
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

const postDependencies = {
  requireCurrentUser,
  enforceUserRateLimit,
  convexQuery,
  convexMutation,
  loadModelCatalog,
  getAiBillingEntitlement,
  isUserOpenRouterKeyRequired,
  encryptSecret,
  secretFingerprint,
  maskFingerprint,
};

export function createAiSettingsPost(overrides: Partial<typeof postDependencies> = {}) {
  const {
    requireCurrentUser,
    enforceUserRateLimit,
    convexQuery,
    convexMutation,
    loadModelCatalog,
    getAiBillingEntitlement,
    isUserOpenRouterKeyRequired,
    encryptSecret,
    secretFingerprint,
    maskFingerprint,
  } = { ...postDependencies, ...overrides };
  return async function postAiSettings(req: NextRequest) {
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
      typeof body.provider === 'string' && PROVIDERS.has(body.provider)
        ? (body.provider as Provider)
        : undefined;
    if (mode === 'byok' && !provider) {
      return NextResponse.json(
        { ok: false, error: 'provider is required when mode is byok' },
        { status: 400 },
      );
    }
    for (const field of ['model', 'fastModel', 'apiKey']) {
      if (body[field] !== undefined && typeof body[field] !== 'string') {
        return NextResponse.json({ ok: false, error: `${field} must be a string` }, { status: 400 });
      }
    }
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    if (apiKey.length > 4096) {
      return NextResponse.json({ ok: false, error: 'API key is too long' }, { status: 400 });
    }

    const existing = await convexQuery<any>(api.ai.getRuntimeState, { userId: user.userId }).catch(
      () => null,
    );

    if (mode === 'byok' && !apiKey && existing?.key?.provider !== provider) {
      return NextResponse.json(
        { ok: false, error: 'Add an API key for the selected provider.' },
        { status: 400 },
      );
    }

    // Model choices: validated against the catalog for the provider in play.
    // A body that omits a slot keeps the saved choice when the provider did not
    // change (the iOS client omits both slots for direct keys).
    const validationProvider: Provider = mode === 'lab86' ? 'openrouter' : provider!;
    const sameProvider = existing?.settings?.provider === validationProvider;
    const requestedModel =
      typeof body.model === 'string' && body.model.trim()
        ? body.model.trim()
        : sameProvider
          ? existing?.settings?.model
          : undefined;
    const requestedFastModel =
      typeof body.fastModel === 'string' && body.fastModel.trim()
        ? body.fastModel.trim()
        : sameProvider
          ? existing?.settings?.fastModel
          : undefined;
    const { catalog } = await loadModelCatalog({ provider: validationProvider }).catch((err) => {
      console.error('[ai-settings] failed to load the model catalog', err);
      return { catalog: buildModelCatalog({ provider: validationProvider }), live: false, liveData: [] };
    });
    const normalChoice = validateModelChoice({
      provider: validationProvider,
      slot: 'normal',
      value: requestedModel,
      catalog,
    });
    if (!normalChoice.ok) return NextResponse.json({ ok: false, error: normalChoice.error }, { status: 400 });
    const fastChoice = validateModelChoice({
      provider: validationProvider,
      slot: 'fast',
      value: requestedFastModel,
      catalog,
    });
    if (!fastChoice.ok) return NextResponse.json({ ok: false, error: fastChoice.error }, { status: 400 });
    const model = normalChoice.id;
    const fastModel = fastChoice.id;

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
      imageUrl: user.imageUrl,
    });
    await convexMutation(api.ai.upsertSettings, {
      userId: user.userId,
      mode,
      provider,
      model,
      fastModel,
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
    return NextResponse.json({
      ok: true,
      model,
      fastModel,
      unknown: normalChoice.unknown || fastChoice.unknown,
      unknownSlots: { model: normalChoice.unknown, fastModel: fastChoice.unknown },
      replaced: {
        model: normalChoice.replaced ?? null,
        fastModel: fastChoice.replaced ?? null,
      },
    });
  };
}

export const POST = createAiSettingsPost();

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
