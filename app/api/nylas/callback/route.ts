import { NextRequest, NextResponse } from 'next/server';
import { requireCurrentUser } from '@/lib/auth/current-user';
import { syncCalendarAccount } from '@/lib/calendar/sync';
import { maybeKickContactSync } from '@/lib/contacts/sync';
import { api, convexMutation } from '@/lib/hosted/convex';
import { hostedPublicUrl, nylasRedirectUri } from '@/lib/hosted/env';
import { maybeKickCorpusBackfill } from '@/lib/mail/corpus-sync';
import { requireNylas } from '@/lib/nylas/client';
import { completeNylasConnection, type NylasOAuthCompletionPayload } from '@/lib/nylas/oauth-connection';
import { encryptSecret } from '@/lib/security/crypto';
import { saveOAuthCompletion } from '@/lib/security/oauth-completions';
import { NATIVE_NYLAS_CALLBACK, sanitizeInternalPath } from '@/lib/security/redirect';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const defaultDependencies = {
  convexMutation,
  requireNylas,
  encryptSecret,
  nylasRedirectUri,
  syncCalendarAccount,
  maybeKickCorpusBackfill,
  maybeKickContactSync,
  requireCurrentUser,
  saveOAuthCompletion: (input: { userId: string; kind: 'mail'; payload: NylasOAuthCompletionPayload }) =>
    saveOAuthCompletion(input),
};

// The OAuth state alone does not prove who approved the provider: a user can
// start a connection and send the provider link to someone else. The web flow
// therefore requires the Clerk session of the user who started it. The native
// flow has no session in the system browser, so it keeps the provider result
// for the app to redeem through the authenticated /api/nylas/finalize route.
export function createNylasOAuthCallback(deps: typeof defaultDependencies = defaultDependencies) {
  return async function nylasOAuthCallback(req: NextRequest) {
    const url = new URL(req.url);
    const code = url.searchParams.get('code') || '';
    const state = url.searchParams.get('state') || '';
    const providerError = url.searchParams.get('error_description') || url.searchParams.get('error') || '';
    if (!state) return redirectWithStatus('/', 'nylas_error', 'Missing OAuth state.');

    let redirectTo = '/';
    let nativeCallback = false;
    try {
      const stored = await deps.convexMutation<any>(api.accounts.consumeOAuthState, { state });
      if (!stored) return redirectWithStatus('/', 'nylas_error', 'OAuth state is invalid or expired.');
      redirectTo = stored.redirectTo || '/';
      nativeCallback = stored.nativeCallback === true || redirectTo === NATIVE_NYLAS_CALLBACK;
      if (providerError) {
        console.warn('[nylas/callback] provider denied authorization', providerError);
        return redirectWithStatus(
          redirectTo,
          'nylas_error',
          'Authorization was not completed. Please try again.',
          nativeCallback,
        );
      }
      if (!code) {
        return redirectWithStatus(
          redirectTo,
          'nylas_error',
          'The provider did not return an authorization code.',
          nativeCallback,
        );
      }
      if (nativeCallback) {
        const completionToken = await deps.saveOAuthCompletion({
          userId: stored.userId,
          kind: 'mail',
          payload: { code, provider: stored.provider },
        });
        return redirectWithStatus(redirectTo, 'nylas_completion', completionToken, true);
      }
      const sessionUser = await deps.requireCurrentUser().catch(() => null);
      if (!sessionUser || sessionUser.userId !== stored.userId) {
        return redirectWithStatus(redirectTo, 'nylas_error', 'Sign in again and retry the connection.');
      }
      await completeNylasConnection({ userId: stored.userId, code, provider: stored.provider }, deps);
      return redirectWithStatus(redirectTo, 'nylas_connected', '1');
    } catch (err: any) {
      console.error('[nylas/callback] OAuth connection failed', err);
      return redirectWithStatus(
        redirectTo,
        'nylas_error',
        'Could not complete authorization. Please try again.',
        nativeCallback,
      );
    }
  };
}

export const GET = createNylasOAuthCallback();

function redirectWithStatus(path: string, key: string, value: string, nativeCallback = false) {
  if (nativeCallback || path === NATIVE_NYLAS_CALLBACK) {
    const target = new URL('lab86://oauth/mail');
    target.searchParams.set(key, value);
    return NextResponse.redirect(target);
  }
  const target = new URL(sanitizeInternalPath(path), hostedPublicUrl());
  target.searchParams.set(key, value);
  return NextResponse.redirect(target);
}
