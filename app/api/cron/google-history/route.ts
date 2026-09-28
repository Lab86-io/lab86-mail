import { type NextRequest, NextResponse } from 'next/server';
import { runWithAiRequestContext } from '@/lib/ai/context';
import { isInternalCronRequest } from '@/lib/cron-auth';
import { syncGoogleHistory } from '@/lib/google/history-sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const defaultDependencies = { isInternalCronRequest, syncGoogleHistory };

// Called by the Convex cron googleDirect:historyTick every 2 minutes, once for
// each direct Google account. The run outlives the response, so the route
// answers at once.
export function createGoogleHistoryPost(overrides: Partial<typeof defaultDependencies> = {}) {
  const deps = { ...defaultDependencies, ...overrides };
  return async function POST(req: NextRequest) {
    if (!deps.isInternalCronRequest(req)) {
      return NextResponse.json({ ok: false, error: 'Unauthorized.' }, { status: 401 });
    }
    const body: any = await req.json().catch(() => ({}));
    const userId = String(body?.userId || '').trim();
    const accountId = String(body?.accountId || '').trim();
    if (!userId || !accountId) {
      return NextResponse.json({ ok: false, error: 'userId and accountId are required.' }, { status: 400 });
    }
    void runWithAiRequestContext({ userId, agent: 'ai' }, () =>
      deps.syncGoogleHistory({ userId, accountId }).catch((err) => {
        console.error('[cron/google-history] sync failed', accountId, (err as Error)?.message || err);
      }),
    );
    return NextResponse.json({ ok: true, started: accountId }, { status: 202 });
  };
}

export const POST = createGoogleHistoryPost();
