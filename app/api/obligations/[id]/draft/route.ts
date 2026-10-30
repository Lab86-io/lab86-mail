import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { prepareObligationDraft } from '@/lib/obligations/service';
import {
  type ObligationRouteContext,
  type ObligationRouteDependencies,
  obligationCaller,
  obligationErrorResponse,
  obligationRouteDefaults,
} from '../../shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/obligations/[id]/draft: a prepared reply for a mail `reply`
// obligation (ObligationDraftResponse). It is kept for the current source
// message, so a second open costs no model call.
export function createObligationDraftPost(overrides: Partial<ObligationRouteDependencies> = {}) {
  const deps = { ...obligationRouteDefaults, ...overrides };
  return async function POST(_req: NextRequest, context: ObligationRouteContext) {
    try {
      const caller = await obligationCaller(deps, 'obligation-draft', 20);
      const { id } = await context.params;
      return NextResponse.json(await prepareObligationDraft(caller, id, deps.service));
    } catch (error) {
      return obligationErrorResponse(error, '[obligations] draft failed');
    }
  };
}

export const POST = createObligationDraftPost();
