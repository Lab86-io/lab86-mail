import type { NextRequest } from 'next/server';
import { resumeStepRun, StepRunStartError, startStepRun } from '@/lib/albatross/step-run-start';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation } from '@/lib/hosted/convex';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '@/lib/rate-limit';
import { errorAnswerMessage } from '@/lib/security/error-answer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface StepRunRouteDependencies {
  requireCurrentUser: typeof requireCurrentUser;
  enforceUserRateLimit: typeof enforceUserRateLimit;
  convexMutation: typeof convexMutation;
  startStepRun: typeof startStepRun;
  resumeStepRun: typeof resumeStepRun;
}

const defaults: StepRunRouteDependencies = {
  requireCurrentUser,
  enforceUserRateLimit,
  convexMutation,
  startStepRun,
  resumeStepRun,
};

function text(value: unknown, max = 300) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/**
 * The step runner's controls (docs/albatross-step-runner.md): start a run on
 * a step, continue after a handoff, stop a run, or dismiss a handoff. The run
 * itself starts in the background; clients watch the run row.
 */
export function createStepRunPost(overrides: Partial<StepRunRouteDependencies> = {}) {
  const deps = { ...defaults, ...overrides };
  return async function POST(req: NextRequest, context: { params: Promise<{ workId: string }> }) {
    try {
      const user = await deps.requireCurrentUser();
      await deps.enforceUserRateLimit({
        userId: user.userId,
        key: 'albatross-step-run',
        limit: 20,
        windowMs: 60_000,
      });
      const { workId } = await context.params;
      const body = await req.json().catch(() => ({}));
      const action = text(body?.action, 20);
      const userId = user.userId;

      if (action === 'start') {
        const stepKey = text(body?.stepKey);
        if (!stepKey) return Response.json({ ok: false, error: 'stepKey is required.' }, { status: 400 });
        const result = await deps.startStepRun({ userId, workId, stepKey, trigger: 'user' });
        if (!result.created || !result.runId)
          return Response.json(
            { ok: false, error: 'Albatross could not start on this step now. Try again.' },
            { status: 409 },
          );
        return Response.json({ ok: true, runId: result.runId });
      }
      if (action === 'resume') {
        const runId = text(body?.runId);
        if (!runId) return Response.json({ ok: false, error: 'runId is required.' }, { status: 400 });
        const result = await deps.resumeStepRun({ userId, workId, runId, note: text(body?.note, 2_000) });
        if (!result.runId)
          return Response.json(
            { ok: false, error: 'Albatross could not continue this step now. Try again.' },
            { status: 409 },
          );
        return Response.json({ ok: true, runId: result.runId });
      }
      if (action === 'steer') {
        // A note to the run that works now (docs/albatross-thread.md).
        const runId = text(body?.runId);
        const note = text(body?.note, 2_000);
        if (!runId || !note)
          return Response.json({ ok: false, error: 'runId and note are required.' }, { status: 400 });
        const steered = await deps
          .convexMutation<boolean>(api.albatrossStepRuns.steer, { userId, id: runId, text: note })
          .catch((error) => {
            if (/Run not found|ArgumentValidationError|Invalid argument/i.test(String(error?.message)))
              return null;
            throw error;
          });
        if (steered === null) return Response.json({ ok: false, error: 'Run not found.' }, { status: 404 });
        if (!steered)
          return Response.json({ ok: false, error: 'This run is not working now.' }, { status: 409 });
        return Response.json({ ok: true, runId });
      }
      if (action === 'cancel' || action === 'dismiss') {
        const runId = text(body?.runId);
        if (!runId) return Response.json({ ok: false, error: 'runId is required.' }, { status: 400 });
        try {
          if (action === 'cancel') {
            const cancelled = await deps.convexMutation<{
              cancelled: boolean;
              browserSessionId: string | null;
            }>(api.albatrossStepRuns.cancel, { userId, id: runId });
            // Taking over: the page goes to the user at once, not at the runner's next heartbeat.
            if (cancelled.browserSessionId)
              await deps
                .convexMutation(api.albatrossBrowserSessions.setSessionStatus, {
                  userId,
                  sessionId: cancelled.browserSessionId,
                  status: 'user',
                  statusDetail: 'You have the page.',
                })
                .catch(() => undefined);
          } else {
            await deps.convexMutation(api.albatrossStepRuns.dismissHandoff, { userId, id: runId });
          }
        } catch (error) {
          if (
            /Run not found|ArgumentValidationError|Invalid argument/i.test(String((error as Error)?.message))
          )
            return Response.json({ ok: false, error: 'Run not found.' }, { status: 404 });
          throw error;
        }
        return Response.json({ ok: true });
      }
      return Response.json({ ok: false, error: 'Unknown action.' }, { status: 400 });
    } catch (error) {
      if (error instanceof RateLimitError) return rateLimitResponse(error);
      if (error instanceof StepRunStartError)
        return Response.json({ ok: false, error: error.message }, { status: error.status });
      const status = error instanceof AuthRequiredError ? 401 : 500;
      return Response.json(
        {
          ok: false,
          error: errorAnswerMessage(status, error, 'The run failed to start.', '[albatross/work/run] failed'),
        },
        { status },
      );
    }
  };
}

export const POST = createStepRunPost();
