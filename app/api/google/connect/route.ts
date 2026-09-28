import { type NextRequest, NextResponse } from 'next/server';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { GoogleConnectError, type GoogleMailMode, startGoogleMailConnect } from '@/lib/google/connect';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MODES = new Set<GoogleMailMode>(['switch', 'new', 'reconnect']);

const defaultDependencies = { requireCurrentUser, enforceUserRateLimit, startGoogleMailConnect };

/**
 * Starts the direct Google mail sign-in (docs/google-direct-transport.md).
 * `?mode=switch&account=<email or accountId>` moves a Nylas Google account to
 * Gmail in place; `?mode=new` connects a Google account. `native=1&format=json`
 * returns the URL for the app's web authentication session.
 */
export function createGoogleConnectGet(dependencies: typeof defaultDependencies = defaultDependencies) {
  return async function googleConnectGet(req: NextRequest) {
    try {
      const user = await dependencies.requireCurrentUser();
      await dependencies.enforceUserRateLimit({
        userId: user.userId,
        key: 'google_mail_oauth_connect',
        limit: 10,
        windowMs: 10 * 60_000,
      });
      const params = req.nextUrl.searchParams;
      const account = params.get('account') || undefined;
      const mode = (params.get('mode') || (account ? 'switch' : 'new')) as GoogleMailMode;
      if (!MODES.has(mode)) {
        return NextResponse.json(
          { ok: false, error: 'mode must be switch, new, or reconnect.' },
          { status: 400 },
        );
      }
      const native = params.get('native') === '1';
      const started = await dependencies.startGoogleMailConnect({
        userId: user.userId,
        mode,
        account,
        redirectTo: params.get('redirectTo'),
        native,
        host: req.headers.get('host'),
      });
      if (params.get('format') === 'json') {
        return NextResponse.json({
          ok: true,
          authorizationUrl: started.authorizationUrl,
          mode: started.mode,
        });
      }
      return NextResponse.redirect(started.authorizationUrl);
    } catch (error) {
      if (error instanceof RateLimitError) return rateLimitJson(error);
      if (error instanceof AuthRequiredError) {
        return NextResponse.json({ ok: false, error: error.message }, { status: 401 });
      }
      if (error instanceof GoogleConnectError) {
        return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
      }
      console.error('[google/connect] failed', (error as Error)?.message || error);
      return NextResponse.json({ ok: false, error: 'Could not start the Google sign-in.' }, { status: 500 });
    }
  };
}

export const GET = createGoogleConnectGet();
