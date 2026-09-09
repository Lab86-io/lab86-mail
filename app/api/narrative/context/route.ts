import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { getNarrativeTaskContext } from '@/lib/narrative/service';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const inputSchema = z.object({
  purpose: z.enum(['chat', 'work', 'area', 'search', 'brief']).default('search'),
  q: z.string().max(240).default(''),
  topic: z.string().max(500).optional(),
});
const defaults = { user: requireCurrentUser, context: getNarrativeTaskContext, rate: enforceUserRateLimit };
export function createNarrativeContextGet(deps = defaults) {
  return async (request: NextRequest) => {
    try {
      const user = await deps.user();
      const input = inputSchema.parse(Object.fromEntries(request.nextUrl.searchParams));
      await deps.rate({ userId: user.userId, key: 'narrative-context', limit: 60, windowMs: 60_000 });
      const context = await deps.context(user.userId, {
        purpose: input.purpose,
        query: input.q,
        topic: input.topic,
      });
      return NextResponse.json(context, { headers: { 'cache-control': 'private, no-store' } });
    } catch (error) {
      if (error instanceof AuthRequiredError)
        return NextResponse.json({ error: 'Sign in required.' }, { status: 401 });
      if (error instanceof RateLimitError) return rateLimitJson(error);
      if (error instanceof z.ZodError)
        return NextResponse.json({ error: 'Invalid context request.' }, { status: 400 });
      return NextResponse.json(
        { error: 'Context is unavailable. Retry without changing your draft.' },
        { status: 503 },
      );
    }
  };
}
export const GET = createNarrativeContextGet();
