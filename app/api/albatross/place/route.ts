import type { NextRequest } from 'next/server';
import { enrichPlace } from '@/lib/albatross/place-enrichment';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/* Named a place? Ground it: Browserbase search + fetch, extract address/hours/
 * online-ordering, return a profile with a deterministic maps link. With an
 * areaId, the findings also land as CANDIDATE facts (source-ref'd) for the
 * user to confirm. */
export async function POST(req: NextRequest) {
  let body: { name?: string; hint?: string; areaId?: string };
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: 'invalid json' });
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return json(400, { ok: false, error: 'name required' });
  try {
    const user = await requireCurrentUser();
    await enforceUserRateLimit({
      userId: user.userId,
      key: 'albatross_place',
      limit: 15,
      windowMs: 60_000,
    });
    const result = await enrichPlace({
      userId: user.userId,
      userEmail: user.email,
      name,
      hint: typeof body.hint === 'string' ? body.hint : undefined,
      areaId: typeof body.areaId === 'string' ? body.areaId : undefined,
    });
    return json(200, { ok: true, ...result });
  } catch (err: any) {
    if (err instanceof RateLimitError) return rateLimitResponse(err);
    if (err instanceof AuthRequiredError) return json(401, { ok: false, error: 'auth required' });
    console.error('[albatross-place-route]', err?.message || err);
    return json(500, { ok: false, error: err?.message || 'place lookup failed' });
  }
}
