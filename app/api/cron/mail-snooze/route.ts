import { type NextRequest, NextResponse } from 'next/server';
import { isInternalCronRequest } from '@/lib/cron-auth';
import { restoreDueSnoozes } from '@/lib/store/snooze';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const defaultDependencies = { isInternalCronRequest, restoreDueSnoozes };

// Called by the Convex mail snooze cron (convex/mailCorpus.ts snoozeTick)
// when a snooze is due. Moves due threads back to the inbox in the background.
export function createMailSnoozePost(overrides: Partial<typeof defaultDependencies> = {}) {
  const deps = { ...defaultDependencies, ...overrides };
  return async function POST(req: NextRequest) {
    if (!deps.isInternalCronRequest(req)) {
      return NextResponse.json({ ok: false, error: 'Unauthorized.' }, { status: 401 });
    }
    void deps.restoreDueSnoozes().catch((err) => {
      console.error('[cron/mail-snooze] restore failed', err);
    });
    return NextResponse.json({ ok: true, started: true }, { status: 202 });
  };
}

export const POST = createMailSnoozePost();
