import type { NextRequest } from 'next/server';
import { classifyRoute, ROUTE_TEXT_MAX_CHARS } from '@/lib/albatross/route-classifier';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { enforceUserRateLimit, RateLimitError, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

// The Ask / Hold bar asks where one line of text goes. Body: `{ text }`.
// Response: `{ ok: true, route: 'ask' | 'hold', confidence }`. A model
// failure or timeout returns `ask` with confidence 0, never an error.

interface AlbatrossRouteDependencies {
  requireCurrentUser: typeof requireCurrentUser;
  enforceUserRateLimit: typeof enforceUserRateLimit;
  classifyRoute: (input: { text: string; nowMs: number; userId: string }) => ReturnType<typeof classifyRoute>;
  now: () => number;
}

const defaultDependencies: AlbatrossRouteDependencies = {
  requireCurrentUser,
  enforceUserRateLimit,
  classifyRoute: (input) => classifyRoute(input),
  now: () => Date.now(),
};

function json(status: number, body: Record<string, unknown>) {
  return Response.json(body, { status });
}

export function createAlbatrossRoutePost(deps: AlbatrossRouteDependencies = defaultDependencies) {
  return async function albatrossRoutePost(req: NextRequest) {
    let body: { text?: unknown };
    try {
      body = await req.json();
    } catch {
      return json(400, { ok: false, error: 'invalid json' });
    }
    if (typeof body?.text !== 'string') return json(400, { ok: false, error: 'text required' });
    const text = body.text.trim();
    if (!text) return json(400, { ok: false, error: 'text required' });
    if (text.length > ROUTE_TEXT_MAX_CHARS) {
      return json(400, { ok: false, error: `text must be at most ${ROUTE_TEXT_MAX_CHARS} characters` });
    }
    try {
      const user = await deps.requireCurrentUser();
      await deps.enforceUserRateLimit({
        userId: user.userId,
        key: 'albatross-route',
        limit: 60,
        windowMs: 60_000,
      });
      const verdict = await deps.classifyRoute({ text, nowMs: deps.now(), userId: user.userId });
      return json(200, { ok: true, route: verdict.route, confidence: verdict.confidence });
    } catch (error) {
      if (error instanceof RateLimitError) return rateLimitResponse(error);
      if (error instanceof AuthRequiredError) return json(401, { ok: false, error: 'auth required' });
      return json(500, { ok: false, error: error instanceof Error ? error.message : 'route failed' });
    }
  };
}

export const POST = createAlbatrossRoutePost();
