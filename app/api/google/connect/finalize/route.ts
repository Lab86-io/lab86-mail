import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { finalizeGoogleMailConnect, GoogleConnectError } from '@/lib/google/connect';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const inputSchema = z.object({
  completionToken: z.string().min(32).max(200),
});

const defaultDependencies = { requireCurrentUser, enforceUserRateLimit, finalizeGoogleMailConnect };

/** The signed-in app redeems the single-use completion token of a native Google sign-in. */
export function createGoogleConnectFinalize(dependencies: typeof defaultDependencies = defaultDependencies) {
  return async function googleConnectFinalize(req: NextRequest) {
    try {
      const user = await dependencies.requireCurrentUser();
      await dependencies.enforceUserRateLimit({
        userId: user.userId,
        key: 'google_mail_oauth_finalize',
        limit: 10,
        windowMs: 10 * 60_000,
      });
      const input = inputSchema.parse(await req.json().catch(() => ({})));
      const result = await dependencies.finalizeGoogleMailConnect({
        userId: user.userId,
        completionToken: input.completionToken,
      });
      return NextResponse.json({ ok: true, accountId: result.accountId, outcome: result.outcome });
    } catch (error) {
      if (error instanceof RateLimitError) return rateLimitJson(error);
      if (error instanceof AuthRequiredError) {
        return NextResponse.json({ ok: false, error: error.message }, { status: 401 });
      }
      if (error instanceof z.ZodError) {
        return NextResponse.json({ ok: false, error: 'Invalid authorization completion.' }, { status: 400 });
      }
      if (error instanceof GoogleConnectError) {
        return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
      }
      console.error('[google/connect/finalize] failed', (error as Error)?.message || error);
      return NextResponse.json(
        { ok: false, error: 'Could not complete the Google connection.' },
        { status: 500 },
      );
    }
  };
}

export const POST = createGoogleConnectFinalize();
