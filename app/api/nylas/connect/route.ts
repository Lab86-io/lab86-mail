import { randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation } from '@/lib/hosted/convex';
import { isNylasConfigured, nylasRedirectUri } from '@/lib/hosted/env';
import { type MailProvider, mailProviderCapability } from '@/lib/mail/provider-capabilities';
import { requireNylas } from '@/lib/nylas/client';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';

const PROVIDERS = new Set(['google', 'microsoft', 'icloud', 'imap']);

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await requireCurrentUser();
  try {
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'nylas_connect',
      limit: 10,
      windowMs: 10 * 60_000,
    });
  } catch (err) {
    if (err instanceof RateLimitError) return rateLimitJson(err);
    throw err;
  }
  if (!isNylasConfigured()) {
    return NextResponse.json(
      { ok: false, error: 'Nylas is not configured. Set NYLAS_API_KEY and NYLAS_CLIENT_ID.' },
      { status: 503 },
    );
  }
  const url = new URL(req.url);
  const provider = url.searchParams.get('provider') || 'google';
  if (!PROVIDERS.has(provider)) {
    return NextResponse.json({ ok: false, error: `Unsupported provider: ${provider}` }, { status: 400 });
  }
  const capability = mailProviderCapability(provider as MailProvider);
  if (!capability.connectable) {
    return NextResponse.json(
      { ok: false, error: capability.reason || `${capability.label} is not available yet.` },
      { status: provider === 'icloud' ? 409 : 404 },
    );
  }
  await convexMutation(api.users.upsertFromClerk, {
    userId: user.userId,
    email: user.email,
    name: user.name,
  });
  const state = randomBytes(24).toString('base64url');
  await convexMutation(api.accounts.createOAuthState, {
    userId: user.userId,
    state,
    provider,
    redirectTo: url.searchParams.get('redirectTo') || '/',
    ttlMs: 10 * 60_000,
  });
  const scopes = (process.env.NYLAS_SCOPES || '')
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
  const authUrl = requireNylas().auth.urlForOAuth2({
    clientId: process.env.NYLAS_CLIENT_ID || '',
    redirectUri: nylasRedirectUri(),
    provider: provider as any,
    accessType: 'offline',
    prompt: 'select_provider',
    includeGrantScopes: true,
    state,
    scope: scopes.length ? scopes : undefined,
  } as any);
  return NextResponse.redirect(authUrl);
}
