import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { sendObligationReply } from '@/lib/obligations/service';
import {
  type ObligationRouteContext,
  type ObligationRouteDependencies,
  obligationCaller,
  obligationErrorResponse,
  obligationRouteDefaults,
} from '../../shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/obligations/[id]/reply with { body }: sends the reply in the
// thread through the compose path (with the user's undo-send delay) and
// closes the obligation as `sent_reply` (ObligationReplyResponse). Undo on
// the obligation inside `undoUntil` cancels the send.
export function createObligationReplyPost(overrides: Partial<ObligationRouteDependencies> = {}) {
  const deps = { ...obligationRouteDefaults, ...overrides };
  return async function POST(req: NextRequest, context: ObligationRouteContext) {
    try {
      const caller = await obligationCaller(deps, 'obligation-reply', 30);
      const { id } = await context.params;
      const body = await req.json().catch(() => null);
      return NextResponse.json(await sendObligationReply(caller, id, body, deps.service));
    } catch (error) {
      return obligationErrorResponse(error, '[obligations] reply failed');
    }
  };
}

export const POST = createObligationReplyPost();
