import type { FunctionReturnType } from 'convex/server';
import type { NextRequest } from 'next/server';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation } from '@/lib/hosted/convex';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const allowed = new Set(['active', 'paused', 'done', 'archived']);

type UpdateWorkStateResult = FunctionReturnType<typeof api.albatrossWorkV2.updateWorkState>;

interface WorkStateDependencies {
  requireCurrentUser: typeof requireCurrentUser;
  enforceUserRateLimit: typeof enforceUserRateLimit;
  updateWorkState(args: {
    userId: string;
    workId: string;
    state: 'active' | 'paused' | 'done' | 'archived';
  }): Promise<UpdateWorkStateResult>;
  reportUnexpectedError: (error: unknown) => void;
}

const defaultDependencies: WorkStateDependencies = {
  requireCurrentUser,
  enforceUserRateLimit,
  updateWorkState: (args) => convexMutation<UpdateWorkStateResult>(api.albatrossWorkV2.updateWorkState, args),
  reportUnexpectedError: (error) => console.error('Work state update failed.', error),
};

export function createWorkStatePost(deps: WorkStateDependencies = defaultDependencies) {
  return async function workStatePost(req: NextRequest, context: { params: Promise<{ workId: string }> }) {
    try {
      const user = await deps.requireCurrentUser();
      await deps.enforceUserRateLimit({
        userId: user.userId,
        key: 'albatross-work-state',
        limit: 60,
        windowMs: 60_000,
      });
      const { workId } = await context.params;
      const body = await req.json().catch(() => ({}));
      const state = body?.state;
      if (typeof state !== 'string' || !allowed.has(state)) {
        return Response.json({ ok: false, error: 'invalid state' }, { status: 400 });
      }
      const result = await deps.updateWorkState({
        userId: user.userId,
        workId,
        state: state as 'active' | 'paused' | 'done' | 'archived',
      });
      return Response.json({
        ok: true,
        previousState: result.previousState,
        state: result.state,
      });
    } catch (error) {
      if (error instanceof RateLimitError) return rateLimitResponse(error);
      if (error instanceof AuthRequiredError) {
        return Response.json({ ok: false, error: error.message }, { status: 401 });
      }
      deps.reportUnexpectedError(error);
      return Response.json({ ok: false, error: 'State update failed.' }, { status: 500 });
    }
  };
}

export const POST = createWorkStatePost();
