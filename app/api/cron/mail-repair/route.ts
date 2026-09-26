import { type NextRequest, NextResponse } from 'next/server';
import { runWithAiRequestContext } from '@/lib/ai/context';
import { isInternalCronRequest } from '@/lib/cron-auth';
import { repairUserMailCorpus, retryFailedWebhookEvents } from '@/lib/mail/corpus-sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const defaultDependencies = { isInternalCronRequest, repairUserMailCorpus, retryFailedWebhookEvents };

// Called by the Convex mail-repair cron (convex/mailCorpus.ts repairTick).
// `kind: 'webhooks'` retries failed webhook events; `kind: 'sweep'` with a
// userId runs the bounded repair sweep for that user's mailboxes. The work
// outlives the response, so the route ACKs at once.
export function createMailRepairPost(overrides: Partial<typeof defaultDependencies> = {}) {
  const deps = { ...defaultDependencies, ...overrides };
  return async function POST(req: NextRequest) {
    if (!deps.isInternalCronRequest(req)) {
      return NextResponse.json({ ok: false, error: 'Unauthorized.' }, { status: 401 });
    }
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      // empty body handled below
    }
    if (body?.kind === 'webhooks') {
      void deps.retryFailedWebhookEvents().catch((err) => {
        console.error('[cron/mail-repair] webhook retry failed', err);
      });
      return NextResponse.json({ ok: true, started: 'webhooks' }, { status: 202 });
    }
    const userId = String(body?.userId || '').trim();
    if (body?.kind !== 'sweep' || !userId) {
      return NextResponse.json(
        { ok: false, error: 'kind webhooks, or kind sweep with a userId, is required.' },
        { status: 400 },
      );
    }
    void runWithAiRequestContext({ userId, agent: 'ai' }, () =>
      deps.repairUserMailCorpus(userId).catch((err) => {
        console.error('[cron/mail-repair] sweep failed', userId, err);
      }),
    );
    return NextResponse.json({ ok: true, started: 'sweep', userId }, { status: 202 });
  };
}

export const POST = createMailRepairPost();
