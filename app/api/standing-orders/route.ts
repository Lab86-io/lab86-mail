import { NextResponse } from 'next/server';
import { AuthRequiredError, requireCurrentUser } from '@/lib/auth/current-user';
import { listStandingOrders, StandingOrderError, setStandingOrderPaused } from '@/lib/hosted/standing-orders';
import { enforceUserRateLimit, RateLimitError, rateLimitJson } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const defaults = {
  requireCurrentUser,
  enforceUserRateLimit,
  listStandingOrders,
  setStandingOrderPaused,
};

/**
 * Standing orders for web, iOS, and macOS.
 *
 * GET  → { ok: true, orders: StandingOrder[] }
 * POST { id: string, paused: boolean } → { ok: true, order: StandingOrder }
 */
export function createStandingOrdersRoute(overrides: Partial<typeof defaults> = {}) {
  const deps = { ...defaults, ...overrides };

  function failure(err: unknown) {
    if (err instanceof RateLimitError) return rateLimitJson(err);
    if (err instanceof AuthRequiredError)
      return NextResponse.json({ ok: false, error: err.message }, { status: 401 });
    if (err instanceof StandingOrderError)
      return NextResponse.json({ ok: false, error: err.message }, { status: err.status });
    const message = err instanceof Error ? err.message : '';
    if (/not found/i.test(message)) return NextResponse.json({ ok: false, error: message }, { status: 404 });
    console.error('[standing-orders] request failed', err instanceof Error ? err.name : err);
    return NextResponse.json({ ok: false, error: 'Could not load standing orders.' }, { status: 500 });
  }

  async function GET() {
    try {
      const user = await deps.requireCurrentUser();
      return NextResponse.json({ ok: true, orders: await deps.listStandingOrders(user.userId) });
    } catch (err) {
      return failure(err);
    }
  }

  async function POST(req: Request) {
    const body = await req.json().catch(() => null);
    const id = typeof body?.id === 'string' ? body.id.trim() : '';
    if (!id || typeof body?.paused !== 'boolean')
      return NextResponse.json({ ok: false, error: 'id and paused are required.' }, { status: 400 });
    try {
      const user = await deps.requireCurrentUser();
      await deps.enforceUserRateLimit({
        userId: user.userId,
        key: 'standing_orders_write',
        limit: 60,
        windowMs: 60_000,
      });
      const order = await deps.setStandingOrderPaused(user.userId, id, body.paused);
      return NextResponse.json({ ok: true, order });
    } catch (err) {
      return failure(err);
    }
  }

  return { GET, POST };
}

export const { GET, POST } = createStandingOrdersRoute();
