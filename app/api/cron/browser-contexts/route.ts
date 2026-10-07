import { type NextRequest, NextResponse } from 'next/server';
import { deleteContextsAtBrowserbase } from '@/lib/albatross/browser-contexts';
import { isInternalCronRequest } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const defaults = { authorized: isInternalCronRequest, deleteContexts: deleteContextsAtBrowserbase };

/** The hourly retry of saved sign-in deletes that Browserbase has not confirmed. */
export function createBrowserContextsCronPost(deps = defaults) {
  return async (request: NextRequest) => {
    if (!deps.authorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await request.json().catch(() => null);
    const contextIds: string[] = Array.isArray(body?.contextIds)
      ? body.contextIds
          .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
          .slice(0, 50)
      : [];
    const result = await deps.deleteContexts(contextIds);
    return NextResponse.json({ ok: true, ...result });
  };
}

export const POST = createBrowserContextsCronPost();
