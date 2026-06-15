import { type NextRequest, NextResponse } from 'next/server';
import { runWithAiRequestContext } from '@/lib/ai/context';
import { syncAllCalendarAccounts } from '@/lib/calendar/sync';
import { isInternalCronRequest } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// Called by the Convex calendar-sync cron (convex/calendarSync.ts) for one
// user. Polls the provider for calendar changes more frequently than the
// webhook-only path so edits made elsewhere show up without waiting.
export async function POST(req: NextRequest) {
  if (!isInternalCronRequest(req)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized.' }, { status: 401 });
  }
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    // empty body handled below
  }
  const userId = String(body?.userId || '').trim();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'userId is required.' }, { status: 400 });
  }
  // Persistent server: the sync outlives the response, so we ACK immediately.
  void runWithAiRequestContext({ userId, agent: 'ai' }, () =>
    syncAllCalendarAccounts(userId).catch((err) => {
      console.error('[cron/calendar-sync] sync failed', userId, err);
    }),
  );
  return NextResponse.json({ ok: true, started: true, userId }, { status: 202 });
}
