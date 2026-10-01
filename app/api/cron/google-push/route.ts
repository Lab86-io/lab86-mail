import { type NextRequest, NextResponse } from 'next/server';
import { isInternalCronRequest } from '@/lib/cron-auth';
import { anyGooglePushEnabled, googlePushFlags } from '@/lib/google/push/config';
import { reconcileGooglePush } from '@/lib/google/push/renewal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const defaultDependencies = { isInternalCronRequest, reconcileGooglePush, googlePushFlags };

// Called by the Convex cron googlePush:renewalTick every hour, once for each
// user with direct Google mail, a Google Drive connection, or push rows. It
// makes, renews, and stops the Gmail watches and the Calendar and Drive
// channels of the user (lib/google/push/renewal.ts). With all push flags off
// and no rows, it does nothing. The run outlives the response.
export function createGooglePushCronPost(overrides: Partial<typeof defaultDependencies> = {}) {
  const deps = { ...defaultDependencies, ...overrides };
  return async function POST(req: NextRequest) {
    if (!deps.isInternalCronRequest(req)) {
      return NextResponse.json({ ok: false, error: 'Unauthorized.' }, { status: 401 });
    }
    const body: any = await req.json().catch(() => ({}));
    const userId = typeof body?.userId === 'string' ? body.userId.trim() : '';
    if (!userId || userId.length > 240) {
      return NextResponse.json({ ok: false, error: 'userId is required.' }, { status: 400 });
    }
    if (!anyGooglePushEnabled(deps.googlePushFlags()) && body?.hasChannels !== true) {
      return NextResponse.json({ ok: true, started: false }, { status: 200 });
    }
    void deps.reconcileGooglePush(userId).catch((err: any) => {
      console.error('[cron/google-push] renewal failed', userId, err?.message || err);
    });
    return NextResponse.json({ ok: true, started: true }, { status: 202 });
  };
}

export const POST = createGooglePushCronPost();
