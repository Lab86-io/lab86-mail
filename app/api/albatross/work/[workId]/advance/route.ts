import type { NextRequest } from 'next/server';
import { advanceWork } from '@/lib/albatross/work-orchestrator';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(req: NextRequest, context: { params: Promise<{ workId: string }> }) {
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'albatross-work-advance',
      limit: 30,
      windowMs: 60_000,
    });
    const { workId } = await context.params;
    const body = await req.json().catch(() => ({}));
    const result = await advanceWork({
      userId: user.userId,
      userEmail: user.email,
      userName: user.name,
      workId,
      timezone: typeof body.timezone === 'string' ? body.timezone : undefined,
      geo:
        typeof body.geo?.latitude === 'number' && typeof body.geo?.longitude === 'number'
          ? { latitude: body.geo.latitude, longitude: body.geo.longitude }
          : undefined,
    });
    return Response.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof RateLimitError) return rateLimitResponse(error);
    const status = error instanceof AuthRequiredError ? 401 : 500;
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : 'advance failed' },
      { status },
    );
  }
}
