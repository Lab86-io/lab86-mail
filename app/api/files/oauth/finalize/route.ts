import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import {
  consumeCloudFileOAuthCompletion,
  exchangeCloudFileAuthorizationCode,
  saveCloudFileConnection,
} from '@/lib/files/connections';
import { CLOUD_FILE_PROVIDER_DEFINITIONS } from '@/lib/files/providers';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const inputSchema = z.object({
  completionToken: z.string().min(32).max(200),
});

const defaultDependencies = {
  requireCurrentUser,
  enforceUserRateLimit,
  consumeCloudFileOAuthCompletion,
  exchangeCloudFileAuthorizationCode,
  saveCloudFileConnection,
};

export function createCloudFileOAuthFinalize(dependencies: typeof defaultDependencies = defaultDependencies) {
  return async function cloudFileOAuthFinalize(req: NextRequest) {
    try {
      const user = await dependencies.requireCurrentUser();
      await dependencies.enforceUserRateLimit({
        userId: user.userId,
        key: 'cloud_file_oauth_finalize',
        limit: 10,
        windowMs: 10 * 60_000,
      });
      const input = inputSchema.parse(await req.json().catch(() => ({})));
      const stored = await dependencies.consumeCloudFileOAuthCompletion({
        userId: user.userId,
        completionToken: input.completionToken,
      });
      if (!stored) {
        return NextResponse.json(
          { ok: false, error: 'File authorization is invalid or expired.' },
          { status: 409 },
        );
      }
      const tokens = await dependencies.exchangeCloudFileAuthorizationCode({
        provider: stored.provider,
        code: stored.authorizationCode,
      });
      const connection = await dependencies.saveCloudFileConnection({
        userId: user.userId,
        provider: stored.provider,
        tokens,
      });
      return NextResponse.json({
        ok: true,
        connected: CLOUD_FILE_PROVIDER_DEFINITIONS[stored.provider].label,
        connectionId: connection.connectionId,
      });
    } catch (error) {
      if (error instanceof RateLimitError) return rateLimitJson(error);
      if (error instanceof AuthRequiredError) {
        return NextResponse.json({ ok: false, error: error.message }, { status: 401 });
      }
      if (error instanceof z.ZodError) {
        return NextResponse.json({ ok: false, error: 'Invalid authorization completion.' }, { status: 400 });
      }
      console.error('[files/oauth/finalize] failed', error);
      return NextResponse.json(
        { ok: false, error: 'Could not complete file authorization.' },
        { status: 500 },
      );
    }
  };
}

export const POST = createCloudFileOAuthFinalize();
