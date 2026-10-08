import type { NextRequest } from 'next/server';
import { resumeStepRun, StepRunStartError, startStepRun } from '@/lib/albatross/step-run-start';
import { appendThreadNote } from '@/lib/albatross/thread-replies';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation } from '@/lib/hosted/convex';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '@/lib/rate-limit';
import { redactSecretShapes } from '@/lib/secure/redact';
import { errorAnswerMessage } from '@/lib/security/error-answer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface StepRunRouteDependencies {
  requireCurrentUser: typeof requireCurrentUser;
  enforceUserRateLimit: typeof enforceUserRateLimit;
  convexMutation: typeof convexMutation;
  startStepRun: typeof startStepRun;
  resumeStepRun: typeof resumeStepRun;
  appendThreadNote: typeof appendThreadNote;
}

const defaults: StepRunRouteDependencies = {
  requireCurrentUser,
  enforceUserRateLimit,
  convexMutation,
  startStepRun,
  resumeStepRun,
  appendThreadNote,
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
        // Many threads at once, each steered (docs/albatross-threads.md).
        limit: 60,
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
        const result = await deps.resumeStepRun({
          userId,
          workId,
          runId,
          note: redactSecretShapes(text(body?.note, 2_000)).text,
        });
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
        // A secret the user wrote never reaches the run's model (docs/albatross-secure-store.md).
        const note = redactSecretShapes(text(body?.note, 2_000)).text;
        if (!runId || !note)
          return Response.json({ ok: false, error: 'runId and note are required.' }, { status: 400 });
        const noteId = text(body?.noteId, 120);
        const steered = await deps
          .convexMutation<boolean>(api.albatrossStepRuns.steer, {
            userId,
            id: runId,
            text: note,
            ...(noteId ? { noteId } : {}),
          })
          .catch((error) => {
            if (/Run not found|ArgumentValidationError|Invalid argument/i.test(String(error?.message)))
              return null;
            throw error;
          });
        if (steered === null) return Response.json({ ok: false, error: 'Run not found.' }, { status: 404 });
        if (!steered)
          return Response.json({ ok: false, error: 'This run is not working now.' }, { status: 409 });
        // The note shows in its thread on every device, also when it was sent from a list row.
        const messageId = await deps
          .appendThreadNote({
            userId,
            userEmail: user.email,
            userName: user.name,
            workId,
            runId,
            note,
            noteId,
          })
          .catch(() => null);
        return Response.json({ ok: true, runId, ...(messageId ? { messageId } : {}) });
      }
      if (action === 'redirect') {
        // "Stop and redirect" (docs/albatross-threads.md, T8): the run stops at
        // once and a new run starts from there with the note. Notes the old run
        // did not read carry to the new one.
        const runId = text(body?.runId);
        const note = redactSecretShapes(text(body?.note, 2_000)).text;
        if (!runId || !note)
          return Response.json({ ok: false, error: 'runId and note are required.' }, { status: 400 });
        let cancelled: { cancelled: boolean };
        try {
          cancelled = await deps.convexMutation<{ cancelled: boolean }>(api.albatrossStepRuns.cancel, {
            userId,
            id: runId,
          });
        } catch (error) {
          if (
            /Run not found|ArgumentValidationError|Invalid argument/i.test(String((error as Error)?.message))
          )
            return Response.json({ ok: false, error: 'Run not found.' }, { status: 404 });
          throw error;
        }
        if (!cancelled.cancelled)
          return Response.json({ ok: false, error: 'This run is not working now.' }, { status: 409 });
        const result = await deps.resumeStepRun({ userId, workId, runId, note });
        if (!result.runId)
          return Response.json(
            { ok: false, error: 'Albatross stopped, but it could not start again now. Try again.' },
            { status: 409 },
          );
        const messageId = await deps
          .appendThreadNote({
            userId,
            userEmail: user.email,
            userName: user.name,
            workId,
            runId: result.runId,
            note,
            noteId: text(body?.noteId, 120) || null,
            redirect: true,
          })
          .catch(() => null);
        return Response.json({ ok: true, runId: result.runId, ...(messageId ? { messageId } : {}) });
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
