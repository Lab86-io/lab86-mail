import type { NextRequest } from 'next/server';
import { advanceWork } from '@/lib/albatross/work-orchestrator';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(req: NextRequest, context: { params: Promise<{ workId: string }> }) {
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'albatross-work-proof',
      limit: 30,
      windowMs: 60_000,
    });
    const { workId } = await context.params;
    const body = await req.json().catch(() => ({}));
    if (!body.claim || !body.title || !body.sourceKind || !body.sourceId || !body.trust) {
      return Response.json({ ok: false, error: 'Proof details are required.' }, { status: 400 });
    }
    const evidenceId = await convexMutation<string>((api as any).albatrossWorkV2.attachProof, {
      userId: user.userId,
      workId,
      claim: String(body.claim),
      title: String(body.title),
      summary: typeof body.summary === 'string' ? body.summary : undefined,
      limits: typeof body.limits === 'string' ? body.limits : undefined,
      url: typeof body.url === 'string' ? body.url : undefined,
      sourceKind: body.sourceKind,
      sourceId: String(body.sourceId),
      connectionId: typeof body.connectionId === 'string' ? body.connectionId : undefined,
      accountId: typeof body.accountId === 'string' ? body.accountId : undefined,
      occurredAt: typeof body.occurredAt === 'number' ? body.occurredAt : undefined,
      trust: body.trust,
      proofId: typeof body.proofId === 'string' ? body.proofId : undefined,
    });
    const detail = await convexQuery<any>((api as any).albatrossWorkV2.workDetail, {
      userId: user.userId,
      workId,
    });
    const closed = detail?.work?.workState === 'done';
    if (!closed) {
      await advanceWork({
        userId: user.userId,
        userEmail: user.email,
        userName: user.name,
        workId,
        timezone: typeof body.timezone === 'string' ? body.timezone : undefined,
      });
    }
    return Response.json({ ok: true, evidenceId, closed, replanned: !closed });
  } catch (error) {
    if (error instanceof RateLimitError) return rateLimitResponse(error);
    const status = error instanceof AuthRequiredError ? 401 : 500;
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : 'Proof could not be attached.' },
      { status },
    );
  }
}
