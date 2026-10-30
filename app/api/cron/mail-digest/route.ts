import { type NextRequest, NextResponse } from 'next/server';
import { describeModelError } from '@/lib/ai/log-error';
import { isInternalCronRequest } from '@/lib/cron-auth';
import { releaseDueMailDigests } from '@/lib/notifications/mail-digest';
import { releaseHeldObligationPushes } from '@/lib/obligations/delivery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const defaultDependencies = { isInternalCronRequest, releaseDueMailDigests, releaseHeldObligationPushes };

// Called by the Convex mail digest cron (convex/albatrossNotifications.ts
// mailDigestTick) when a held mail push or a held Needs you push is due.
// Sends in the background.
export function createMailDigestPost(overrides: Partial<typeof defaultDependencies> = {}) {
  const deps = { ...defaultDependencies, ...overrides };
  return async function POST(req: NextRequest) {
    if (!deps.isInternalCronRequest(req)) {
      return NextResponse.json({ ok: false, error: 'Unauthorized.' }, { status: 401 });
    }
    void deps.releaseDueMailDigests().catch((err) => {
      console.error('[cron/mail-digest] release failed', describeModelError(err));
    });
    void deps.releaseHeldObligationPushes().catch((err) => {
      console.error('[cron/mail-digest] obligation release failed', describeModelError(err));
    });
    return NextResponse.json({ ok: true, started: true }, { status: 202 });
  };
}

export const POST = createMailDigestPost();
