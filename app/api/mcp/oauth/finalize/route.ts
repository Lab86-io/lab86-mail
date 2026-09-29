import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { describeModelError } from '@/lib/ai/log-error';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { completeMcpOAuthConnection, type McpOAuthCompletionPayload } from '@/lib/mcp/oauth-connection';
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
  consumeOAuthCompletion: (input: { userId: string; kind: 'mcp'; completionToken: string }) =>
    consumeOAuthCompletion<McpOAuthCompletionPayload>(input),
  completeMcpOAuthConnection: (input: McpOAuthCompletionPayload & { userId: string }) =>
    completeMcpOAuthConnection(input),
};

// The native app redeems the single-use token from /api/mcp/oauth/callback
// here, with its own Clerk session. The token only works for the user who
// started the connection, so an approval from another browser is refused.
export function createMcpOAuthFinalize(deps: typeof defaultDependencies = defaultDependencies) {
  return async function mcpOAuthFinalize(req: NextRequest) {
    try {
      const user = await deps.requireCurrentUser();
      await deps.enforceUserRateLimit({
        userId: user.userId,
        key: 'mcp_oauth_finalize',
        limit: 10,
        windowMs: 10 * 60_000,
      });
      const input = inputSchema.parse(await req.json().catch(() => ({})));
      const stored = await deps.consumeOAuthCompletion({
        userId: user.userId,
        kind: 'mcp',
        completionToken: input.completionToken,
      });
      if (!stored?.code) {
        return NextResponse.json(
          { ok: false, error: 'Connection authorization is invalid or expired.' },
          { status: 409 },
        );
      }
      const result = await deps.completeMcpOAuthConnection({ ...stored, userId: user.userId });
      if (!result.ok) {
        console.warn('[mcp/oauth/finalize] initial sync failed', stored.server, result.error);
        return NextResponse.json(
          { ok: false, error: 'Connected, but the first sync failed. Please reconnect and try again.' },
          { status: 502 },
        );
      }
      return NextResponse.json({ ok: true, connected: result.label, connectionId: result.connectionId });
    } catch (error) {
      if (error instanceof RateLimitError) return rateLimitJson(error);
      if (error instanceof AuthRequiredError) {
        return NextResponse.json({ ok: false, error: error.message }, { status: 401 });
      }
      if (error instanceof z.ZodError) {
        return NextResponse.json({ ok: false, error: 'Invalid authorization completion.' }, { status: 400 });
      }
      console.error('[mcp/oauth/finalize] failed', describeModelError(error));
      return NextResponse.json(
        { ok: false, error: 'Could not complete authorization. Please try again.' },
        { status: 500 },
      );
    }
  };
}

export const POST = createMcpOAuthFinalize();
