import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { BriefComponentError, briefComponentStore } from '@/lib/brief/component-state';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const defaults = { user: requireCurrentUser, store: briefComponentStore, rate: enforceUserRateLimit };
export function createBriefComponentRoutes(deps = defaults) {
  const handle = (write: boolean) => async (request: NextRequest) => {
    try {
      const user = await deps.user();
      await deps.rate({
        userId: user.userId,
        key: `brief-components-${write ? 'write' : 'read'}`,
        limit: write ? 60 : 180,
        windowMs: 60_000,
      });
      let result: unknown;
      if (write) {
        const body = await request.text();
        if (body.length > 30000) throw new BriefComponentError('The answer is too large.', 413);
        result = await deps.store.write(user.userId, JSON.parse(body));
      } else
        result = (
          await deps.store.read(user.userId, {
            reportId: request.nextUrl.searchParams.get('reportId'),
            componentId: request.nextUrl.searchParams.get('componentId'),
          })
        ).state;
      return NextResponse.json(result, { headers: { 'cache-control': 'private, no-store' } });
    } catch (error) {
      if (error instanceof AuthRequiredError)
        return NextResponse.json({ error: 'Sign in required.' }, { status: 401 });
      if (error instanceof RateLimitError) return rateLimitJson(error);
      if (error instanceof BriefComponentError)
        return NextResponse.json({ error: error.message }, { status: error.status });
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return NextResponse.json({ error: 'Invalid brief input.' }, { status: 400 });
      console.error('[brief-components] request failed', {
        name: error instanceof Error ? error.name : 'UnknownError',
      });
      return NextResponse.json(
        { error: 'Your answer could not be saved. Please try again.' },
        { status: 503 },
      );
    }
  };
  return { GET: handle(false), POST: handle(true) };
}
export const { GET, POST } = createBriefComponentRoutes();
