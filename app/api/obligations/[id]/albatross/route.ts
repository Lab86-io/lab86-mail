import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireCurrentUser } from '@/lib/auth/current-user';
import {
  type ObligationAlbatrossDependencies,
  startObligationInAlbatross,
} from '@/lib/obligations/albatross';
import { enforceUserRateLimit } from '@/lib/rate-limit';
import { type ObligationRouteContext, obligationErrorResponse } from '../../shared';
import { obligationAlbatrossDefaults } from './shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/obligations/[id]/albatross ("Start in Albatross"): the item goes
// into its Albatross and reaches a run, or a new Albatross starts from it
// (ObligationAlbatrossResponse, lib/obligations/contract.ts). No body.

export interface ObligationAlbatrossRouteDependencies {
  requireCurrentUser: typeof requireCurrentUser;
  enforceUserRateLimit: typeof enforceUserRateLimit;
  albatross: ObligationAlbatrossDependencies;
}

const defaults: ObligationAlbatrossRouteDependencies = {
  requireCurrentUser,
  enforceUserRateLimit,
  albatross: obligationAlbatrossDefaults,
};

export function createObligationAlbatrossPost(overrides: Partial<ObligationAlbatrossRouteDependencies> = {}) {
  const deps = { ...defaults, ...overrides };
  return async function POST(_req: NextRequest, context: ObligationRouteContext) {
    try {
      const user = await deps.requireCurrentUser();
      await deps.enforceUserRateLimit({
        userId: user.userId,
        key: 'obligation-albatross',
        limit: 20,
        windowMs: 60_000,
      });
      const caller = { userId: user.userId, email: user.email, name: user.name };
      const { id } = await context.params;
      return NextResponse.json(await startObligationInAlbatross(caller, id, deps.albatross));
    } catch (error) {
      return obligationErrorResponse(error, '[obligations] start in Albatross failed');
    }
  };
}

export const POST = createObligationAlbatrossPost();
