import type { NextRequest } from 'next/server';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexQuery } from '@/lib/hosted/convex';
import {
  type BriefHydratedEntity,
  BriefResolveRequestSchema,
  BriefResolveResponseSchema,
} from '@/lib/shared/brief-hydration';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface BriefResolveDependencies {
  currentUser: typeof requireCurrentUser;
  resolve(args: {
    userId: string;
    refs: Array<{ kind: 'thread' | 'task' | 'event' | 'card' | 'work'; id: string; account?: string }>;
  }): Promise<BriefHydratedEntity[]>;
}

const dependencies: BriefResolveDependencies = {
  currentUser: requireCurrentUser,
  resolve: (args) => convexQuery((api as any).mobile.resolveBriefRefs, args),
};

export function createBriefResolvePost(deps: BriefResolveDependencies = dependencies) {
  return async function briefResolvePost(request: NextRequest) {
    try {
      const user = await deps.currentUser();
      const parsed = BriefResolveRequestSchema.safeParse(await request.json());
      if (!parsed.success) {
        return Response.json({ ok: false, error: 'Invalid brief refs.' }, { status: 400 });
      }
      const refs = parsed.data.refs
        .filter(
          (
            ref,
          ): ref is typeof ref & {
            kind: 'thread' | 'task' | 'event' | 'card' | 'work';
          } => ['thread', 'task', 'event', 'card', 'work'].includes(ref.kind),
        )
        .map(({ kind, id, account }) => ({ kind, id, ...(account ? { account } : {}) }));
      if (!refs.length) return Response.json({ ok: true, entities: [] });
      const entities = await deps.resolve({ userId: user.userId, refs });
      return Response.json(BriefResolveResponseSchema.parse({ ok: true, entities }));
    } catch (error) {
      if (error instanceof AuthRequiredError) {
        return Response.json({ ok: false, error: error.message }, { status: 401 });
      }
      return Response.json({ ok: false, error: 'Brief references could not be resolved.' }, { status: 500 });
    }
  };
}

export const POST = createBriefResolvePost();
