import type { NextRequest } from 'next/server';
import { checkinCallerArgs } from '@/lib/albatross/checkin';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation } from '@/lib/hosted/convex';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type PromptKind = 'reflection' | 'tomorrow';

interface CheckinAnswerDependencies {
  requireCurrentUser: typeof requireCurrentUser;
  enforceUserRateLimit: typeof enforceUserRateLimit;
  convexMutation: typeof convexMutation;
  reportUnexpectedError: typeof console.error;
}

const defaults: CheckinAnswerDependencies = {
  requireCurrentUser,
  enforceUserRateLimit,
  convexMutation,
  reportUnexpectedError: console.error,
};

function completedEntries(value: unknown) {
  return Array.isArray(value)
    ? value
        .map((entry: any) => ({ kind: String(entry?.kind || ''), id: String(entry?.id || '') }))
        .filter((entry) => entry.kind && entry.id)
        .slice(0, 60)
    : [];
}

function promptKind(value: unknown): PromptKind | null {
  return value === 'reflection' || value === 'tomorrow' ? value : null;
}

export function createCheckinAnswerPost(deps: CheckinAnswerDependencies = defaults) {
  return async function POST(req: NextRequest, context: { params: Promise<{ checkinId: string }> }) {
    try {
      const user = await deps.requireCurrentUser();
      await deps.enforceUserRateLimit({
        userId: user.userId,
        key: 'albatross-checkin-answer',
        limit: 30,
        windowMs: 60_000,
      });
      const { checkinId } = await context.params;
      const parsedBody = await req.json().catch(() => ({}));
      const body =
        parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody) ? parsedBody : {};
      const requestedKind = promptKind((body as any).promptKind);
      const reflectionText = String((body as any).responseText || '').trim();
      const tomorrowText = requestedKind
        ? requestedKind === 'tomorrow'
          ? reflectionText
          : ''
        : String((body as any).tomorrowIntentText || '').trim();
      const selected = completedEntries((body as any).completed);
      const savesReflection =
        requestedKind === 'reflection' || (!requestedKind && Boolean(reflectionText || selected.length));
      const savesTomorrow = requestedKind === 'tomorrow' || (!requestedKind && Boolean(tomorrowText));
      if (!savesReflection && !savesTomorrow) {
        return Response.json({ ok: false, error: 'Tell Albatross what happened.' }, { status: 400 });
      }
      if (requestedKind === 'reflection' && !reflectionText && !selected.length) {
        return Response.json({ ok: false, error: 'Tell Albatross what happened.' }, { status: 400 });
      }
      if (requestedKind === 'tomorrow' && !tomorrowText) {
        return Response.json({ ok: false, error: 'Say what tomorrow should protect.' }, { status: 400 });
      }

      const caller = checkinCallerArgs(user.userId);
      let result: any = { status: 'open' };
      if (savesReflection) {
        result = await deps.convexMutation<any>((api as any).albatrossNotifications.answerCheckin, {
          ...caller,
          checkinId,
          promptKind: 'reflection',
          responseText: reflectionText,
          completed: selected,
        });
      }
      if (savesTomorrow) {
        result = await deps.convexMutation<any>((api as any).albatrossNotifications.answerCheckin, {
          ...caller,
          checkinId,
          promptKind: 'tomorrow',
          responseText: tomorrowText,
          completed: [],
        });
      }

      return Response.json({
        ok: true,
        ...result,
        saved: { reflection: savesReflection, tomorrow: savesTomorrow },
        ...(savesReflection
          ? { reflectionReconcileStatus: result.reflectionReconcileStatus || 'pending' }
          : {}),
        ...(savesTomorrow ? { tomorrowPlanStatus: result.tomorrowPlanStatus || 'pending' } : {}),
      });
    } catch (error) {
      if (error instanceof RateLimitError) return rateLimitResponse(error);
      if (error instanceof AuthRequiredError) {
        return Response.json({ ok: false, error: error.message }, { status: 401 });
      }
      deps.reportUnexpectedError('[albatross/checkin/answer] request failed', error);
      return Response.json({ ok: false, error: 'Check-in answer failed.' }, { status: 500 });
    }
  };
}

export const POST = createCheckinAnswerPost();
