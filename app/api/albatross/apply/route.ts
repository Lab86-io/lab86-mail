import type { NextRequest } from 'next/server';
import { newOperationBatchId } from '@/lib/ai/operations';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '@/lib/rate-limit';
import { albatrossApplyIntentPlan } from '@/lib/tools/albatross';
import { invokeTool, type ToolContext } from '@/lib/tools/registry';
import { tasksAttachLink } from '@/lib/tools/tasks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/* One POST turns a stored ready plan into real artifacts: tasks, calendar
 * events, drafts, and a project when warranted — all through the existing
 * albatross_apply_intent_plan tool (single operation batch, approvals queued
 * for human-facing actions). The plan's HTML brief is then attached to the
 * first created task so the plan lives with the work. */
export async function POST(req: NextRequest) {
  let body: { planId?: string; projectMode?: 'auto' | 'project' | 'task_only' };
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: 'invalid json' });
  }
  if (!body.planId || typeof body.planId !== 'string') {
    return json(400, { ok: false, error: 'planId required' });
  }
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'albatross_apply',
      limit: 30,
      windowMs: 60_000,
    });

    const artifact = await convexQuery<any>((api as any).albatrossIntents.getPlanArtifact, {
      userId: user.userId,
      planId: body.planId,
    });
    if (artifact.status === 'applied') return json(409, { ok: false, error: 'Plan already applied.' });
    const workbench = await convexQuery<any>((api as any).albatrossIntents.getIntentWorkbench, {
      userId: user.userId,
      intentId: artifact.intentId,
    });
    const plan = workbench.plan;
    const intent = workbench.intent;
    if (!plan || String(plan._id) !== body.planId) {
      return json(409, { ok: false, error: 'Plan is no longer the latest for its intent.' });
    }
    const openQuestions = (intent.questions || []).filter((question: any) => !question.answer);
    if (plan.status === 'needs_answers' && openQuestions.length) {
      return json(409, { ok: false, error: 'Answer the open questions before applying.' });
    }

    const ctx: ToolContext = {
      agent: 'user',
      userId: user.userId,
      userEmail: user.email,
      userName: user.name,
      operationBatchId: newOperationBatchId(),
    };

    const result: any = await invokeTool(
      albatrossApplyIntentPlan,
      {
        intentId: String(intent._id),
        intentText: intent.rawText,
        areaId: intent.areaId,
        projectMode: body.projectMode || 'auto',
        projectTitle: plan.proposedProjectTitle,
        plan: {
          id: String(plan._id),
          intentId: String(intent._id),
          outcome: plan.outcome,
          digitalActions: plan.digitalActions,
          sourceRefs: plan.sourceRefs,
        },
      },
      ctx,
    );

    // Attach the plan brief to the first created task so the "why" and the
    // real-world steps travel with the work. Best-effort: a failed attach
    // must not report the whole apply as failed.
    let artifactAttachedTo: string | undefined;
    if (artifact.artifactHtml) {
      const firstTask = (result.operations || []).find(
        (operation: any) => operation.tool === 'tasks_create_card' && operation.artifactId,
      );
      if (firstTask) {
        const artifactUrl = new URL(
          `/api/albatross/plan/${body.planId}/artifact`,
          req.nextUrl.origin,
        ).toString();
        try {
          await invokeTool(
            tasksAttachLink,
            {
              cardId: String(firstTask.artifactId),
              name: `Plan brief: ${artifact.artifactTitle || intent.title || 'Albatross plan'}`,
              url: artifactUrl,
            },
            ctx,
          );
          artifactAttachedTo = String(firstTask.artifactId);
        } catch (err) {
          console.warn('[albatross-apply] artifact attach failed:', err);
        }
      }
    }

    await convexMutation((api as any).albatrossIntents.markPlanApplied, {
      userId: user.userId,
      planId: body.planId,
      applicationId: result.applicationId,
    });

    return json(200, {
      ok: true,
      operationBatchId: result.operationBatchId,
      applicationId: result.applicationId,
      projectId: result.projectId,
      operations: result.operations,
      approvals: result.approvals,
      unresolved: result.unresolved,
      artifactAttachedTo,
    });
  } catch (err: any) {
    if (err instanceof RateLimitError) return rateLimitResponse(err);
    if (err instanceof AuthRequiredError) return json(401, { ok: false, error: 'auth required' });
    console.error('[albatross-apply-route]', err?.message || err);
    return json(500, { ok: false, error: err?.message || 'apply failed' });
  }
}
