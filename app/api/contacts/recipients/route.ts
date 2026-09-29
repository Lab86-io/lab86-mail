import { NextResponse } from 'next/server';
import { describeModelError } from '@/lib/ai/log-error';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { checkRecipientRateLimit, readExcludeParam, suggestRecipients } from '@/lib/contacts/lookup';
import { RateLimitError, rateLimitJson } from '@/lib/rate-limit';
import { truncateText } from '@/lib/shared/text';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

// Web compose recipient search. The same ranking as the native endpoint
// (/api/mobile/v1/contacts/recipients), with the web's plain JSON shape.
const defaults = {
  requireCurrentUser,
  checkRateLimit: checkRecipientRateLimit,
  suggest: (userId: string, input: Parameters<typeof suggestRecipients>[1]) =>
    suggestRecipients(userId, input),
};

export function createRecipientsGet(deps = defaults) {
  return async function recipientsGet(request: Request) {
    try {
      const user = await deps.requireCurrentUser();
      deps.checkRateLimit(user.userId);
      const url = new URL(request.url);
      const query = truncateText((url.searchParams.get('q') || '').trim(), 200);
      const limit = Math.min(Math.max(Math.floor(Number(url.searchParams.get('limit')) || 8), 1), 10);
      const result = await deps.suggest(user.userId, {
        query,
        fromAccountId: url.searchParams.get('from')?.trim() || undefined,
        limit,
        exclude: readExcludeParam(url.searchParams.getAll('exclude')),
      });
      return NextResponse.json({ ok: true, query, items: result.items });
    } catch (err: any) {
      if (err instanceof RateLimitError) return rateLimitJson(err);
      if (err instanceof AuthRequiredError) {
        return NextResponse.json({ ok: false, error: err.message }, { status: 401 });
      }
      console.error('[contacts/recipients] search failed', describeModelError(err));
      return NextResponse.json({ ok: false, error: 'Recipient search failed.' }, { status: 500 });
    }
  };
}

export const GET = createRecipientsGet();
