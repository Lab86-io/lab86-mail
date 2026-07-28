import { type NextRequest, NextResponse } from 'next/server';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { saveCloudFileOAuthState } from '@/lib/files/connections';
import {
  buildCloudFileAuthorizationUrl,
  type CloudFileProvider,
  cloudFileProviderCredentials,
  cloudFileProviderDefinition,
} from '@/lib/files/providers';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';
import { sanitizeInternalPath } from '@/lib/security/redirect';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const defaultDependencies = {
  requireCurrentUser,
  enforceUserRateLimit,
  saveCloudFileOAuthState,
  cloudFileProviderDefinition,
  cloudFileProviderCredentials,
  buildCloudFileAuthorizationUrl,
};

export function createCloudFileOAuthStart(dependencies: typeof defaultDependencies = defaultDependencies) {
  return async function cloudFileOAuthStart(req: NextRequest) {
    try {
      const user = await dependencies.requireCurrentUser();
      await dependencies.enforceUserRateLimit({
        userId: user.userId,
        key: 'cloud_file_oauth_connect',
        limit: 10,
        windowMs: 10 * 60_000,
      });
      const provider = req.nextUrl.searchParams.get('provider') || '';
      const definition = dependencies.cloudFileProviderDefinition(provider);
      if (!definition) {
        return NextResponse.json(
          { ok: false, error: `Unsupported file provider: ${provider}` },
          { status: 400 },
        );
      }
      const credentials = dependencies.cloudFileProviderCredentials(provider as CloudFileProvider);
      if (!credentials) {
        return NextResponse.json(
          {
            ok: false,
            error: `${definition.label} needs OAuth credentials configured by the workspace owner.`,
          },
          { status: 503 },
        );
      }
      const redirectTo = sanitizeInternalPath(req.nextUrl.searchParams.get('redirectTo') || '/?view=files');
      const nativeCallback = req.nextUrl.searchParams.get('native') === '1';
      const transaction = await dependencies.saveCloudFileOAuthState({
        userId: user.userId,
        provider: provider as CloudFileProvider,
        redirectTo,
        nativeCallback,
      });
      const authorizationUrl = dependencies.buildCloudFileAuthorizationUrl({
        provider: provider as CloudFileProvider,
        state: transaction.state,
        clientId: credentials.clientId,
        codeChallenge: transaction.codeChallenge,
      });
      if (nativeCallback && req.nextUrl.searchParams.get('format') === 'json') {
        return NextResponse.json({ ok: true, authorizationUrl });
      }
      return NextResponse.redirect(authorizationUrl);
    } catch (error) {
      if (error instanceof RateLimitError) return rateLimitJson(error);
      if (error instanceof AuthRequiredError) {
        return NextResponse.json({ ok: false, error: error.message }, { status: 401 });
      }
      console.error('[files/oauth/start] failed', error);
      return NextResponse.json({ ok: false, error: 'Could not start file authorization.' }, { status: 500 });
    }
  };
}

export const GET = createCloudFileOAuthStart();
