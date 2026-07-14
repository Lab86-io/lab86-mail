import type { NextRequest } from 'next/server';
import { generateIntentPlan } from '@/lib/albatross/intent-plan';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Plan generation runs two model passes plus artifact search; give it room.
export const maxDuration = 300;

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export async function POST(req: NextRequest) {
  let body: {
    intentId?: string;
    timezone?: string;
    geo?: { latitude?: number; longitude?: number };
  };
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: 'invalid json' });
  }
  if (!body.intentId || typeof body.intentId !== 'string') {
    return json(400, { ok: false, error: 'intentId required' });
  }
  const geo =
    typeof body.geo?.latitude === 'number' &&
    Number.isFinite(body.geo.latitude) &&
    typeof body.geo?.longitude === 'number' &&
    Number.isFinite(body.geo.longitude)
      ? { latitude: body.geo.latitude, longitude: body.geo.longitude }
      : undefined;
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'albatross_plan',
      limit: 20,
      windowMs: 60_000,
    });
    const result = await generateIntentPlan({
      userId: user.userId,
      userEmail: user.email,
      userName: user.name,
      timezone: typeof body.timezone === 'string' ? body.timezone : undefined,
      intentId: body.intentId,
      geo,
    });
    return json(200, { ok: true, planId: result.planId });
  } catch (err: any) {
    if (err instanceof RateLimitError) return rateLimitResponse(err);
    if (err instanceof AuthRequiredError) return json(401, { ok: false, error: 'auth required' });
    console.error('[albatross-plan-route]', err?.message || err);
    return json(500, { ok: false, error: err?.message || 'plan generation failed' });
  }
}
