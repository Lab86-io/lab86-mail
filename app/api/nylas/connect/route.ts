import { randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import type { Provider, URLForAuthenticationConfig } from 'nylas';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { directGoogleConnectChoice, GoogleConnectError, startGoogleMailConnect } from '@/lib/google/connect';
import { api, convexMutation } from '@/lib/hosted/convex';
import { isNylasConfigured, nylasRedirectUri } from '@/lib/hosted/env';
import { type MailProvider, mailProviderCapability } from '@/lib/mail/provider-capabilities';
import { requireNylas } from '@/lib/nylas/client';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';
import { NATIVE_NYLAS_CALLBACK, sanitizeInternalPath } from '@/lib/security/redirect';

const PROVIDERS = new Set(['google', 'microsoft', 'icloud', 'imap']);

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface NylasConnectDependencies {
  requireCurrentUser: typeof requireCurrentUser;
  isNylasConfigured: typeof isNylasConfigured;
  enforceUserRateLimit: typeof enforceUserRateLimit;
  convexMutation: typeof convexMutation;
  requireNylas: typeof requireNylas;
  nylasRedirectUri: typeof nylasRedirectUri;
  randomState: () => string;
  // Direct Google transport (docs/google-direct-transport.md). Absent in
  // tests that cover only the Nylas flow.
  directGoogleConnectChoice?: typeof directGoogleConnectChoice;
  startGoogleMailConnect?: typeof startGoogleMailConnect;
}

const defaultDependencies: NylasConnectDependencies = {
  requireCurrentUser,
  isNylasConfigured,
  enforceUserRateLimit,
  convexMutation,
  requireNylas,
  nylasRedirectUri,
  randomState: () => randomBytes(24).toString('base64url'),
  directGoogleConnectChoice,
  startGoogleMailConnect,
};

export function createNylasConnectGet(deps: NylasConnectDependencies = defaultDependencies) {
  return async function nylasConnectGet(req: NextRequest) {
    let user: Awaited<ReturnType<typeof requireCurrentUser>>;
    try {
      user = await deps.requireCurrentUser();
    } catch (error) {
      if (error instanceof AuthRequiredError) {
        return NextResponse.json({ ok: false, error: error.message }, { status: 401 });
      }
      throw error;
    }
    // Configuration problems should surface before any rate-limit quota is spent.
    if (!deps.isNylasConfigured()) {
      return NextResponse.json(
        { ok: false, error: 'Nylas is not configured. Set NYLAS_API_KEY and NYLAS_CLIENT_ID.' },
        { status: 503 },
      );
    }
    try {
      await deps.enforceUserRateLimit({
        userId: user.userId,
        key: 'nylas_connect',
        limit: 10,
        windowMs: 10 * 60_000,
      });
    } catch (err) {
      if (err instanceof RateLimitError) return rateLimitJson(err);
      throw err;
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
    await deps.convexMutation(api.users.upsertFromClerk, {
      userId: user.userId,
      email: user.email,
      name: user.name,
      imageUrl: user.imageUrl,
    });
    const isNative = url.searchParams.get('native') === '1';
    if (provider === 'google' && deps.directGoogleConnectChoice && deps.startGoogleMailConnect) {
      // LAB86_GOOGLE_DIRECT=1 sends Google connections to Gmail directly
      // (docs/google-direct-transport.md).
      const choice = await deps.directGoogleConnectChoice({ userId: user.userId });
      if (choice) {
        try {
          const started = await deps.startGoogleMailConnect({
            userId: user.userId,
            mode: choice.mode,
            account: choice.account,
            redirectTo: url.searchParams.get('redirectTo'),
            native: isNative,
            host: req.headers.get('host'),
          });
          if (url.searchParams.get('format') === 'json') {
            return NextResponse.json({ ok: true, authorizationUrl: started.authorizationUrl });
          }
          return NextResponse.redirect(started.authorizationUrl);
        } catch (error) {
          if (error instanceof GoogleConnectError) {
            return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
          }
          throw error;
        }
      }
    }
    const state = deps.randomState();
    await deps.convexMutation(api.accounts.createOAuthState, {
      userId: user.userId,
      state,
      provider,
      redirectTo: isNative ? NATIVE_NYLAS_CALLBACK : sanitizeInternalPath(url.searchParams.get('redirectTo')),
      nativeCallback: isNative,
      ttlMs: 10 * 60_000,
    });
    const scopes = scopesForProvider(provider as MailProvider);
    const config: URLForAuthenticationConfig = {
      clientId: process.env.NYLAS_CLIENT_ID || '',
      redirectUri: deps.nylasRedirectUri(),
      provider: provider as Provider,
      accessType: 'offline',
      prompt: 'select_provider',
      includeGrantScopes: true,
      state,
      ...(scopes.length ? { scope: scopes } : {}),
    };
    const authUrl = deps.requireNylas().auth.urlForOAuth2(config);
    if (url.searchParams.get('format') === 'json') {
      return NextResponse.json({ ok: true, authorizationUrl: authUrl });
    }
    return NextResponse.redirect(authUrl);
  };
}

export const GET = createNylasConnectGet();

// Scopes are provider-specific (Gmail scope URLs mean nothing to Microsoft,
// and iCloud/IMAP take none). A per-provider env wins; the legacy NYLAS_SCOPES
// applies to Google only; everyone else uses the Nylas connector defaults.
function scopesForProvider(provider: MailProvider): string[] {
  const raw =
    process.env[`NYLAS_SCOPES_${provider.toUpperCase()}`] ??
    (provider === 'google' ? process.env.NYLAS_SCOPES : undefined) ??
    '';
  return raw
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
}
