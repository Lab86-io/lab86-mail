import { NextRequest, NextResponse } from 'next/server';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { getAiBillingEntitlement } from '@/lib/hosted/billing';
import {
  isLab86AiDisabled,
  isSubscriptionServiceDisabled,
  isUserOpenRouterKeyRequired,
} from '@/lib/hosted/controls';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { isConvexConfigured } from '@/lib/hosted/env';
import { encryptSecret, maskFingerprint, secretFingerprint } from '@/lib/security/crypto';

const PROVIDERS = new Set(['openrouter', 'openai', 'anthropic']);

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await requireCurrentUser();
  if (!isConvexConfigured()) {
    return NextResponse.json({
      ok: true,
      configured: false,
      mode: 'legacy',
      message: 'Convex is not configured; AI uses server environment keys only.',
    });
  }
  const state = await convexQuery<any>(api.ai.getRuntimeState, { userId: user.userId });
  const entitlement = await getAiBillingEntitlement();
  const requireOpenRouter = isUserOpenRouterKeyRequired();
  const monthlyCredits = requireOpenRouter ? 0 : entitlement.monthlyCredits;
  const creditsUsed = state.lab86Usage?.creditsUsed || 0;
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
    entitlement,
    lab86AiDisabled: isLab86AiDisabled(),
    requiresUserOpenRouterKey: requireOpenRouter,
    subscriptionsDisabled: isSubscriptionServiceDisabled(),
    usage: {
      period: state.period,
      creditsUsed,
      monthlyCredits,
      remaining: Math.max(0, monthlyCredits - creditsUsed),
    },
  });
}

export async function POST(req: NextRequest) {
  const user = await requireCurrentUser({ allowLegacy: false });
  const body = await req.json().catch(() => ({}));
  const mode = body.mode === 'byok' ? 'byok' : 'lab86';
  const provider = PROVIDERS.has(body.provider) ? body.provider : undefined;
  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : undefined;
  const fastModel =
    typeof body.fastModel === 'string' && body.fastModel.trim() ? body.fastModel.trim() : undefined;
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';

  if (isUserOpenRouterKeyRequired()) {
    const existing = isConvexConfigured()
      ? await convexQuery<any>(api.ai.getRuntimeState, { userId: user.userId }).catch(() => null)
      : null;
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
    fastModel,
    enabled: body.enabled !== false,
  });

  if (apiKey) {
    if (!provider) {
      return NextResponse.json(
        { ok: false, error: 'provider is required when saving an API key' },
        { status: 400 },
      );
    }
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
  const user = await requireCurrentUser({ allowLegacy: false });
  const url = new URL(req.url);
  const provider = url.searchParams.get('provider') || '';
  if (!PROVIDERS.has(provider)) {
    return NextResponse.json({ ok: false, error: 'valid provider is required' }, { status: 400 });
  }
  await convexMutation(api.ai.deleteProviderKey, { userId: user.userId, provider });
  return NextResponse.json({ ok: true });
}
