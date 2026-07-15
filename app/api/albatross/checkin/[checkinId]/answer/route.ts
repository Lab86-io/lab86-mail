import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { generateTextForCurrentUser } from '@/lib/ai/gateway';
import { checkinCallerArgs } from '@/lib/albatross/checkin';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;

const reconciliationSchema = z.object({
  completed: z
    .array(z.object({ kind: z.string(), id: z.string() }))
    .max(60)
    .default([]),
});

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

export async function POST(req: NextRequest, context: { params: Promise<{ checkinId: string }> }) {
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'albatross-checkin-answer',
      limit: 30,
      windowMs: 60_000,
    });
    const { checkinId } = await context.params;
    const body = await req.json();
    const responseText = String(body.responseText || '').trim();
    const selected = Array.isArray(body.completed)
      ? body.completed
          .map((entry: any) => ({ kind: String(entry.kind || ''), id: String(entry.id || '') }))
          .filter((entry: any) => entry.kind && entry.id)
      : [];
    if (!responseText && !selected.length) {
      return Response.json({ ok: false, error: 'Tell Albatross what happened.' }, { status: 400 });
    }
    const caller = checkinCallerArgs(user.userId);
    const checkin = await convexQuery<any>((api as any).albatrossNotifications.getCheckin, {
      ...caller,
      checkinId,
    });
    if (!checkin) return Response.json({ ok: false, error: 'Check-in not found.' }, { status: 404 });
    let inferred: Array<{ kind: string; id: string }> = [];
    if (responseText) {
      const { text } = await generateTextForCurrentUser({
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
    const result = await convexMutation<any>((api as any).albatrossNotifications.answerCheckin, {
      ...caller,
      checkinId,
      responseText,
      completed: deduped,
    });
    return Response.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof RateLimitError) return rateLimitResponse(error);
    const status = error instanceof AuthRequiredError ? 401 : 500;
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : 'check-in answer failed' },
      { status },
    );
  }
}
