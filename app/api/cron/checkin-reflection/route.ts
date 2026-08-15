import { type NextRequest, NextResponse } from 'next/server';
import { generateTextForCurrentUser } from '@/lib/ai/gateway';
import { parseCheckinReconciliation } from '@/lib/albatross/checkin';
import { isInternalCronRequest } from '@/lib/cron-auth';
import { api, convexMutation } from '@/lib/hosted/convex';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

interface ReflectionDependencies {
  isInternalCronRequest: typeof isInternalCronRequest;
  generateTextForCurrentUser: typeof generateTextForCurrentUser;
  convexMutation: typeof convexMutation;
  reportError: typeof console.error;
}

const defaults: ReflectionDependencies = {
  isInternalCronRequest,
  generateTextForCurrentUser,
  convexMutation,
  reportError: console.error,
};

export function createCheckinReflectionPost(deps: ReflectionDependencies = defaults) {
  return async function POST(req: NextRequest) {
    if (!deps.isInternalCronRequest(req)) {
      return NextResponse.json({ ok: false, error: 'Unauthorized.' }, { status: 401 });
    }
    const body = await req.json().catch(() => ({}));
    const userId = String(body?.userId || '').trim();
    const checkinId = String(body?.checkinId || '').trim();
    const responseText = String(body?.responseText || '').trim();
    const candidateItems = Array.isArray(body?.candidateItems) ? body.candidateItems.slice(0, 60) : [];
    if (!userId || !checkinId || !responseText) {
      return NextResponse.json(
        { ok: false, error: 'userId, checkinId, and responseText are required.' },
        { status: 400 },
      );
    }
    try {
      const generated = await deps.generateTextForCurrentUser({
        feature: 'albatross_checkin_reconcile',
        speed: 'fast',
        userId,
        system: `Reconcile a user's end-of-day report with a supplied list of candidate items.
Return JSON only: {"completed":[{"kind":string,"id":string}]}.
Mark an item completed only when the user's words explicitly say it was done, finished, shipped, sent, filed, or otherwise completed. Partial progress, attendance, planning, silence, or an elapsed calendar event are not completion. Use only exact kind/id pairs from candidates. Never invent an item.`,
        prompt: `Candidate items:\n${JSON.stringify(candidateItems, null, 2)}\n\nUser report:\n${responseText}`,
      });
      const reconciled = parseCheckinReconciliation(generated.text);
      const result = await deps.convexMutation<any>(
        (api as any).albatrossNotifications.completeReflectionReconcile,
        { userId, checkinId, completed: reconciled.completed },
      );
      return NextResponse.json({ ok: true, checkinId, ...result });
    } catch (error) {
      deps.reportError('[cron/checkin-reflection] reconciliation failed', checkinId, error);
      await deps
        .convexMutation((api as any).albatrossNotifications.failReflectionReconcile, {
          userId,
          checkinId,
          error: 'Reflection reconciliation is temporarily unavailable.',
        })
        .catch(() => undefined);
      return NextResponse.json(
        { ok: false, error: 'Reflection reconciliation failed.', checkinId },
        { status: 500 },
      );
    }
  };
}

export const POST = createCheckinReflectionPost();
