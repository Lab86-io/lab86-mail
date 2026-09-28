import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { completeNylasConnection, type NylasOAuthCompletionPayload } from '@/lib/nylas/oauth-connection';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';
import { consumeOAuthCompletion } from '@/lib/security/oauth-completions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const inputSchema = z.object({
  completionToken: z.string().min(32).max(200),
});

const defaultDependencies = {
  requireCurrentUser,
  enforceUserRateLimit,
  consumeOAuthCompletion: (input: { userId: string; kind: 'mail'; completionToken: string }) =>
    consumeOAuthCompletion<NylasOAuthCompletionPayload>(input),
  completeNylasConnection: (input: { userId: string; code: string; provider?: string }) =>
    completeNylasConnection(input),
};

// The native app redeems the single-use token from /api/nylas/callback here,
// with its own Clerk session. The token only works for the user who started
// the connection, so an approval from another person's browser is refused.
export function createNylasOAuthFinalize(deps: typeof defaultDependencies = defaultDependencies) {
  return async function nylasOAuthFinalize(req: NextRequest) {
    try {
      const user = await deps.requireCurrentUser();
      await deps.enforceUserRateLimit({
        userId: user.userId,
        key: 'nylas_oauth_finalize',
        limit: 10,
        windowMs: 10 * 60_000,
      });
      const input = inputSchema.parse(await req.json().catch(() => ({})));
      const stored = await deps.consumeOAuthCompletion({
        userId: user.userId,
        kind: 'mail',
        completionToken: input.completionToken,
      });
      if (!stored?.code) {
        return NextResponse.json(
          { ok: false, error: 'Mailbox authorization is invalid or expired.' },
          { status: 409 },
        );
      }
      await deps.completeNylasConnection({
        userId: user.userId,
        code: stored.code,
        provider: stored.provider,
      });
      return NextResponse.json({ ok: true });
    } catch (error) {
      if (error instanceof RateLimitError) return rateLimitJson(error);
      if (error instanceof AuthRequiredError) {
        return NextResponse.json({ ok: false, error: error.message }, { status: 401 });
      }
      if (error instanceof z.ZodError) {
        return NextResponse.json({ ok: false, error: 'Invalid authorization completion.' }, { status: 400 });
      }
      console.error('[nylas/finalize] failed', error);
      return NextResponse.json(
        { ok: false, error: 'Could not complete authorization. Please try again.' },
        { status: 500 },
      );
    }
  };
}

export const POST = createNylasOAuthFinalize();
