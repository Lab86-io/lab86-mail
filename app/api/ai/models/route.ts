import { NextResponse } from 'next/server';
import { defaultModelsFor, loadModelCatalog, providersAvailableFor } from '@/lib/ai/model-catalog';
import type { Provider } from '@/lib/ai/model-options';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexQuery } from '@/lib/hosted/convex';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PROVIDERS = new Set<Provider>(['openrouter', 'openai', 'anthropic']);

/**
 * GET /api/ai/models
 * The structured model catalog for the signed-in user's mode and provider.
 * Lab86 mode sees every vendor; a direct OpenAI or Anthropic key sees only
 * that vendor's models (the rest are marked unavailable).
 */
export async function GET() {
  const user = await requireCurrentUser().catch((err) => {
    if (err instanceof AuthRequiredError) return null;
    throw err;
  });
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Sign in required.' }, { status: 401 });
  }
  const state = await convexQuery<any>(api.ai.getRuntimeState, { userId: user.userId }).catch(() => null);
  const settings = state?.settings;
  const provider: Provider =
    settings?.mode === 'byok' && PROVIDERS.has(settings.provider ?? state?.key?.provider)
      ? (settings.provider ?? state?.key?.provider)
      : 'openrouter';
  const loaded = await loadModelCatalog({ provider });
  return NextResponse.json({
    ok: true,
    mode: settings?.mode ?? 'lab86',
    provider,
    live: loaded.live,
    catalog: loaded.catalog,
    providersAvailable: providersAvailableFor(provider),
    defaults: defaultModelsFor(provider),
  });
}
