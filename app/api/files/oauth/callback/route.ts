import { type NextRequest, NextResponse } from 'next/server';
import {
  consumeCloudFileOAuthState,
  exchangeCloudFileAuthorizationCode,
  saveCloudFileConnection,
} from '@/lib/files/connections';
import { CLOUD_FILE_PROVIDER_DEFINITIONS } from '@/lib/files/providers';
import { hostedPublicUrl } from '@/lib/hosted/env';
import { sanitizeInternalPath } from '@/lib/security/redirect';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const defaultDependencies = {
  consumeCloudFileOAuthState,
  exchangeCloudFileAuthorizationCode,
  saveCloudFileConnection,
};

function filesRedirect(
  path: string | undefined,
  key: 'files_connected' | 'files_error',
  value: string,
  nativeCallback = false,
) {
  const target = nativeCallback
    ? new URL('lab86://files')
    : new URL(sanitizeInternalPath(path || '/?view=files'), hostedPublicUrl());
  target.searchParams.set(key, value.slice(0, 200));
  return NextResponse.redirect(target);
}

export function createCloudFileOAuthCallback(dependencies: typeof defaultDependencies = defaultDependencies) {
  return async function cloudFileOAuthCallback(req: NextRequest) {
    const state = req.nextUrl.searchParams.get('state') || '';
    const code = req.nextUrl.searchParams.get('code') || '';
    const providerError =
      req.nextUrl.searchParams.get('error_description') || req.nextUrl.searchParams.get('error');
    if (!state) {
      return filesRedirect(undefined, 'files_error', 'Missing OAuth state.');
    }

    let redirectTo: string | undefined;
    let nativeCallback = false;
    try {
      const stored = await dependencies.consumeCloudFileOAuthState(state);
      if (!stored) {
        return filesRedirect(undefined, 'files_error', 'OAuth state is invalid or expired.');
      }
      redirectTo = stored.redirectTo;
      nativeCallback = stored.nativeCallback === true;
      if (providerError) {
        console.warn('[files/oauth/callback] authorization denied', stored.provider);
        return filesRedirect(redirectTo, 'files_error', 'Authorization was not completed.', nativeCallback);
      }
      if (!code) {
        return filesRedirect(
          redirectTo,
          'files_error',
          'The provider did not return an authorization code.',
          nativeCallback,
        );
      }
      const tokens = await dependencies.exchangeCloudFileAuthorizationCode({
        provider: stored.provider,
        code,
      });
      await dependencies.saveCloudFileConnection({
        userId: stored.userId,
        provider: stored.provider,
        tokens,
      });
      return filesRedirect(
        redirectTo,
        'files_connected',
        CLOUD_FILE_PROVIDER_DEFINITIONS[stored.provider].label,
        nativeCallback,
      );
    } catch (error) {
      console.error('[files/oauth/callback] failed', error);
      return filesRedirect(
        redirectTo,
        'files_error',
        'Could not complete file authorization.',
        nativeCallback,
      );
    }
  };
}

export const GET = createCloudFileOAuthCallback();
