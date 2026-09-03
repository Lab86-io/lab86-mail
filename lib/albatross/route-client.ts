import { ASK_FALLBACK, type BarRoute, type RouteVerdict, routeHeuristic } from '@/lib/albatross/route-rules';

// The client side of the Ask / Hold route. The heuristic answers at once for
// the clear cases. The endpoint confirms after the typing stops. Every failure
// falls back to "ask", because a wrong "ask" only produces a reply.

export const ROUTE_CONFIRM_DELAY_MS = 250;
export const ROUTE_CLIENT_TIMEOUT_MS = 3_000;

export interface PredictRouteOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** The instant prediction. Unclear text keeps the route the caller already shows. */
export function instantRoute(text: string, current: BarRoute = 'ask'): RouteVerdict {
  const verdict = routeHeuristic(text);
  if (verdict) return verdict;
  return { route: current, confidence: 0, reason: 'unclear' };
}

/** The other route. */
export function flipRoute(route: BarRoute): BarRoute {
  return route === 'ask' ? 'hold' : 'ask';
}

/**
 * Confirm one bar text with `POST /api/albatross/route`. Resolves `ask` with
 * confidence 0 on a timeout, a network error, or a bad body. An aborted
 * request rejects, so a stale answer never lands on newer text.
 */
export async function predictRoute(text: string, options: PredictRouteOptions = {}): Promise<RouteVerdict> {
  const clean = text.trim();
  if (!clean) return { route: 'ask', confidence: 0, reason: 'empty' };
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) throw new DOMException('aborted', 'AbortError');
    options.signal.addEventListener('abort', abort, { once: true });
  }
  const timer = setTimeout(abort, options.timeoutMs ?? ROUTE_CLIENT_TIMEOUT_MS);
  try {
    const response = await fetchImpl('/api/albatross/route', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: clean }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.ok) return ASK_FALLBACK;
    if (body.route !== 'ask' && body.route !== 'hold') return ASK_FALLBACK;
    const confidence = typeof body.confidence === 'number' ? body.confidence : 0;
    return { route: body.route, confidence, reason: 'endpoint' };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return ASK_FALLBACK;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}
