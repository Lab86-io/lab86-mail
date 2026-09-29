import { type NextRequest, NextResponse } from 'next/server';
import { runWithAiRequestContext } from '@/lib/ai/context';
import { describeModelError } from '@/lib/ai/log-error';
import { syncUserContacts } from '@/lib/contacts/sync';
import { isInternalCronRequest } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

interface ContactsCronDependencies {
  isInternalCronRequest: typeof isInternalCronRequest;
  syncUserContacts: typeof syncUserContacts;
}

const defaultDependencies: ContactsCronDependencies = { isInternalCronRequest, syncUserContacts };

// Called by the Convex contacts cron (convex/contacts.ts) for one user with a
// due mailbox. The pass outlives the response, so the route answers at once.
export function createContactsCronPost(deps: ContactsCronDependencies = defaultDependencies) {
  return async function POST(req: NextRequest) {
    if (!deps.isInternalCronRequest(req)) {
      return NextResponse.json({ ok: false, error: 'Unauthorized.' }, { status: 401 });
    }
    const body = await req.json().catch(() => ({}));
    const userId = String(body?.userId || '').trim();
    if (!userId) {
      return NextResponse.json({ ok: false, error: 'userId is required.' }, { status: 400 });
    }
    void runWithAiRequestContext({ userId, agent: 'ai' }, () =>
      deps.syncUserContacts(userId, { reason: 'cron' }).catch((err) => {
        console.error('[cron/contacts-sync] sync failed', userId, describeModelError(err));
      }),
    );
    return NextResponse.json({ ok: true, started: true, userId }, { status: 202 });
  };
}

export const POST = createContactsCronPost();
