import { type NextRequest, NextResponse } from 'next/server';
import { isInternalCronRequest } from '@/lib/cron-auth';
import { releaseDueMailDigests } from '@/lib/notifications/mail-digest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const defaultDependencies = { isInternalCronRequest, releaseDueMailDigests };

// Called by the Convex mail digest cron (convex/albatrossNotifications.ts
// mailDigestTick) when a held mail push is due. Sends in the background.
export function createMailDigestPost(overrides: Partial<typeof defaultDependencies> = {}) {
  const deps = { ...defaultDependencies, ...overrides };
  return async function POST(req: NextRequest) {
    if (!deps.isInternalCronRequest(req)) {
      return NextResponse.json({ ok: false, error: 'Unauthorized.' }, { status: 401 });
    }
    void deps.releaseDueMailDigests().catch((err) => {
      console.error('[cron/mail-digest] release failed', err);
    });
    return NextResponse.json({ ok: true, started: true }, { status: 202 });
  };
}

export const POST = createMailDigestPost();
