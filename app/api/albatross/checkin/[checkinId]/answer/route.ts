import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { generateTextForCurrentUser } from '@/lib/ai/gateway';
import { checkinCallerArgs, tomorrowWorkPlanStatus } from '@/lib/albatross/checkin';
import { advanceWork } from '@/lib/albatross/work-orchestrator';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const reconciliationSchema = z.object({
  completed: z
    .array(z.object({ kind: z.string(), id: z.string() }))
    .max(60)
    .default([]),
});

interface CheckinAnswerDependencies {
  requireCurrentUser: typeof requireCurrentUser;
  enforceUserRateLimit: typeof enforceUserRateLimit;
  generateTextForCurrentUser: typeof generateTextForCurrentUser;
  convexMutation: typeof convexMutation;
  convexQuery: typeof convexQuery;
  advanceWork: typeof advanceWork;
  reportUnexpectedError: typeof console.error;
}

const defaults: CheckinAnswerDependencies = {
  requireCurrentUser,
  enforceUserRateLimit,
  generateTextForCurrentUser,
  convexMutation,
  convexQuery,
  advanceWork,
  reportUnexpectedError: console.error,
};

function parseReconciliation(text: string) {
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return { completed: [] };
    const result = reconciliationSchema.safeParse(JSON.parse(text.slice(start, end + 1)));
    return result.success ? result.data : { completed: [] };
  } catch {
    return { completed: [] };
  }
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
      const responseText = String(body.responseText || '').trim();
      const tomorrowIntentText = String(body.tomorrowIntentText || '').trim();
      const selected = Array.isArray(body.completed)
        ? body.completed
            .map((entry: any) => ({ kind: String(entry.kind || ''), id: String(entry.id || '') }))
            .filter((entry: any) => entry.kind && entry.id)
        : [];
      if (!responseText && !tomorrowIntentText && !selected.length) {
        return Response.json({ ok: false, error: 'Tell Albatross what happened.' }, { status: 400 });
      }
      const caller = checkinCallerArgs(user.userId);
      const checkin = await deps.convexQuery<any>((api as any).albatrossNotifications.getCheckin, {
        ...caller,
        checkinId,
      });
      if (!checkin) return Response.json({ ok: false, error: 'Check-in not found.' }, { status: 404 });
      let inferred: Array<{ kind: string; id: string }> = [];
      if (responseText) {
        const { text } = await deps.generateTextForCurrentUser({
          feature: 'albatross_checkin_reconcile',
          speed: 'fast',
          userId: user.userId,
          userEmail: user.email,
          userName: user.name,
          system: `Reconcile a user's end-of-day report with a supplied list of candidate items.
Return JSON only: {"completed":[{"kind":string,"id":string}]}.
Mark an item completed only when the user's words explicitly say it was done, finished, shipped, sent, filed, or otherwise completed. Partial progress, attendance, planning, silence, or an elapsed calendar event are not completion. Use only exact kind/id pairs from candidates. Never invent an item.`,
          prompt: `Candidate items:\n${JSON.stringify(checkin.candidateItems, null, 2)}\n\nUser report:\n${responseText}`,
        });
        inferred = parseReconciliation(text).completed;
      }
      const deduped = [...selected, ...inferred].filter(
        (entry, index, all) =>
          all.findIndex((candidate) => candidate.kind === entry.kind && candidate.id === entry.id) === index,
      );
      let result: any = { changes: [], status: checkin.status };
      if (responseText || selected.length) {
        result = await deps.convexMutation<any>((api as any).albatrossNotifications.answerCheckin, {
          ...caller,
          checkinId,
          promptKind: 'reflection',
          responseText,
          completed: deduped,
        });
      }
      if (tomorrowIntentText) {
        const tomorrow = await deps.convexMutation<any>((api as any).albatrossNotifications.answerCheckin, {
          ...caller,
          checkinId,
          promptKind: 'tomorrow',
          responseText: tomorrowIntentText,
          completed: [],
        });
        result = {
          ...result,
          status: tomorrow.status,
        };
        let tomorrowWorkId: string | undefined;
        try {
          tomorrowWorkId = await deps.convexMutation<string>((api as any).albatrossIntents.createIntent, {
            ...caller,
            externalId: `checkin:${checkinId}:tomorrow`,
            rawText: tomorrowIntentText,
            source: 'text',
            title: tomorrowIntentText.slice(0, 180),
          });
          const existing = await deps.convexQuery<any>((api as any).albatrossWorkV2.workDetail, {
            userId: user.userId,
            workId: tomorrowWorkId,
          });
          const planStatus = tomorrowWorkPlanStatus(existing);
          if (planStatus === 'advance') {
            const planned = await deps.advanceWork({
              userId: user.userId,
              userEmail: user.email,
              userName: user.name,
              workId: tomorrowWorkId,
              timezone: typeof body.timezone === 'string' ? body.timezone : undefined,
            });
            result = { ...result, tomorrowWorkId, tomorrowPlanStatus: planned.status };
          } else {
            result = {
              ...result,
              tomorrowWorkId,
              tomorrowPlanStatus: planStatus,
            };
          }
        } catch (planningError) {
          deps.reportUnexpectedError(
            '[albatross/checkin/answer] tomorrow planning failed',
            { userId: user.userId, checkinId, workId: tomorrowWorkId },
            planningError,
          );
          result = {
            ...result,
            ...(tomorrowWorkId ? { tomorrowWorkId } : {}),
            tomorrowPlanStatus: 'degraded',
            tomorrowPlanError: 'Tomorrow planning is temporarily unavailable.',
          };
        }
      }
      return Response.json({ ok: true, ...result });
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
