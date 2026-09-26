import { NextResponse } from 'next/server';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { buildDataExport, toWebStream } from '@/lib/hosted/data-export';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const defaults = { requireCurrentUser, enforceUserRateLimit, buildDataExport };

/**
 * GET /api/account/export → application/zip, streamed.
 *
 * The same route serves web (Settings, Account, Export my data, and the
 * account-deletion dialog) and native, with the ordinary signed-in session.
 */
export function createAccountExportGet(overrides: Partial<typeof defaults> = {}) {
  const deps = { ...defaults, ...overrides };
  return async function GET() {
    let userId: string;
    try {
      userId = (await deps.requireCurrentUser()).userId;
      await deps.enforceUserRateLimit({ userId, key: 'account_export', limit: 5, windowMs: 60 * 60_000 });
    } catch (err) {
      if (err instanceof RateLimitError) return rateLimitJson(err);
      if (err instanceof AuthRequiredError)
        return NextResponse.json({ ok: false, error: err.message }, { status: 401 });
      throw err;
    }
    try {
      const { stream, fileName } = await deps.buildDataExport(userId);
      stream.on('error', (err: unknown) =>
        console.error('[account/export] stream failed', err instanceof Error ? err.name : err),
      );
      return new Response(toWebStream(stream), {
        headers: {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="${fileName}"`,
          'cache-control': 'no-store',
        },
      });
    } catch (err) {
      console.error('[account/export] failed', err instanceof Error ? err.name : err);
      return NextResponse.json({ ok: false, error: 'Could not build your export.' }, { status: 500 });
    }
  };
}

export const GET = createAccountExportGet();
