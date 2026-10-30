import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { runObligationAction } from '@/lib/obligations/service';
import {
  type ObligationRouteContext,
  type ObligationRouteDependencies,
  obligationCaller,
  obligationErrorResponse,
  obligationRouteDefaults,
} from '../shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/obligations/[id] with an ObligationAction: done, later, not_mine,
// or undo. Returns ObligationActionResponse (lib/obligations/contract.ts).
export function createObligationActionPost(overrides: Partial<ObligationRouteDependencies> = {}) {
  const deps = { ...obligationRouteDefaults, ...overrides };
  return async function POST(req: NextRequest, context: ObligationRouteContext) {
    try {
      const caller = await obligationCaller(deps, 'obligation-action', 60);
      const { id } = await context.params;
      const body = await req.json().catch(() => null);
      return NextResponse.json(await runObligationAction(caller, id, body, deps.service));
    } catch (error) {
      return obligationErrorResponse(error, '[obligations] action failed');
    }
  };
}

export const POST = createObligationActionPost();
