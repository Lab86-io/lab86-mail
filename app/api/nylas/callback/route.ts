import { NextRequest, NextResponse } from 'next/server';
import { syncCalendarAccount } from '@/lib/calendar/sync';
import { api, convexMutation } from '@/lib/hosted/convex';
import { hostedPublicUrl, nylasRedirectUri } from '@/lib/hosted/env';
import { maybeKickCorpusBackfill } from '@/lib/mail/corpus-sync';
import { requireNylas } from '@/lib/nylas/client';
import { encryptSecret } from '@/lib/security/crypto';
import { NATIVE_NYLAS_CALLBACK, sanitizeInternalPath } from '@/lib/security/redirect';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const defaultDependencies = {
  convexMutation,
  requireNylas,
  encryptSecret,
  syncCalendarAccount,
  maybeKickCorpusBackfill,
};

export function createNylasOAuthCallback(deps: typeof defaultDependencies = defaultDependencies) {
  return async function nylasOAuthCallback(req: NextRequest) {
    const url = new URL(req.url);
    const code = url.searchParams.get('code') || '';
    const state = url.searchParams.get('state') || '';
    const providerError = url.searchParams.get('error_description') || url.searchParams.get('error') || '';
    if (!state) return redirectWithStatus('/', 'nylas_error', 'Missing OAuth state.');

    let redirectTo = '/';
    try {
      const stored = await deps.convexMutation<any>(api.accounts.consumeOAuthState, { state });
      if (!stored) return redirectWithStatus('/', 'nylas_error', 'OAuth state is invalid or expired.');
      redirectTo = stored.redirectTo || '/';
      if (providerError) {
        console.warn('[nylas/callback] provider denied authorization', providerError);
        return redirectWithStatus(
          redirectTo,
          'nylas_error',
          'Authorization was not completed. Please try again.',
        );
      }
      if (!code) {
        return redirectWithStatus(
          redirectTo,
          'nylas_error',
          'The provider did not return an authorization code.',
        );
      }
      const token = await deps.requireNylas().auth.exchangeCodeForToken({
        clientId: process.env.NYLAS_CLIENT_ID || '',
        clientSecret: process.env.NYLAS_CLIENT_SECRET || undefined,
        redirectUri: nylasRedirectUri(),
        code,
      });
      const provider = normalizeProvider(token.provider || stored.provider);
      const scopes = String(token.scope || '')
        .split(/\s+/)
        .map((scope) => scope.trim())
        .filter(Boolean);
      const upserted = await deps.convexMutation<{
        accountId: string;
        replacedGrantId?: string;
      }>(api.accounts.upsertConnectedAccount, {
        userId: stored.userId,
        email: token.email,
        provider,
        grantId: token.grantId,
        accessTokenEncrypted: token.accessToken ? deps.encryptSecret(token.accessToken) : undefined,
        refreshTokenEncrypted: token.refreshToken ? deps.encryptSecret(token.refreshToken) : undefined,
        expiresAt: token.expiresIn ? Date.now() + token.expiresIn * 1000 : undefined,
        scopes,
      });
      if (upserted?.replacedGrantId) {
        await deps
          .requireNylas()
          .grants.destroy({ grantId: upserted.replacedGrantId })
          .catch(() => undefined);
      }
      if (upserted?.accountId) {
        const kick = { userId: stored.userId, accountId: upserted.accountId };
        void (async () => {
          await deps
            .syncCalendarAccount({ ...kick, force: true, reason: 'oauth_callback' })
            .catch(() => undefined);
          deps.maybeKickCorpusBackfill(kick);
        })();
      }
      return redirectWithStatus(redirectTo, 'nylas_connected', '1');
    } catch (err: any) {
      console.error('[nylas/callback] OAuth connection failed', err);
      return redirectWithStatus(
        redirectTo,
        'nylas_error',
        'Could not complete authorization. Please try again.',
      );
    }
  };
}

export const GET = createNylasOAuthCallback();

function normalizeProvider(provider: string) {
  if (provider === 'google' || provider === 'microsoft' || provider === 'icloud') return provider;
  return 'imap';
}

function redirectWithStatus(path: string, key: string, value: string) {
  if (path === NATIVE_NYLAS_CALLBACK) {
    const target = new URL('lab86://oauth/mail');
    target.searchParams.set(key, value);
    return NextResponse.redirect(target);
  }
  const target = new URL(sanitizeInternalPath(path), hostedPublicUrl());
  target.searchParams.set(key, value);
  return NextResponse.redirect(target);
}
