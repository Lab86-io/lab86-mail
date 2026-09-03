import { describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createAlbatrossRoutePost } from '../app/api/albatross/route/route';
import { AuthRequiredError } from '../lib/auth/current-user';
import { RateLimitError } from '../lib/rate-limit';

function request(body: unknown) {
  return new NextRequest('http://localhost/api/albatross/route', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function dependencies() {
  const rateLimitCalls: Array<Record<string, unknown>> = [];
  const classifyCalls: Array<Record<string, unknown>> = [];
  const deps = {
    requireCurrentUser: async () => ({
      userId: 'user_route',
      email: 'owner@example.test',
      name: 'Owner',
      source: 'clerk' as const,
    }),
    enforceUserRateLimit: async (input: Record<string, unknown>) => {
      rateLimitCalls.push(input);
      return { ok: true };
    },
    classifyRoute: async (input: Record<string, unknown>) => {
      classifyCalls.push(input);
      return { route: 'hold' as const, confidence: 0.8, reason: 'errand verb' };
    },
    now: () => 1_700_000_000_000,
  };
  return { deps: deps as any, rateLimitCalls, classifyCalls };
}

describe('POST /api/albatross/route', () => {
  test('returns the route and confidence only, under the albatross-route limit', async () => {
    const { deps, rateLimitCalls, classifyCalls } = dependencies();
    const response = await createAlbatrossRoutePost(deps)(request({ text: '  book the dentist ' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, route: 'hold', confidence: 0.8 });
    expect(rateLimitCalls).toEqual([
      { userId: 'user_route', key: 'albatross-route', limit: 60, windowMs: 60_000 },
    ]);
    expect(classifyCalls).toEqual([
      { text: 'book the dentist', nowMs: 1_700_000_000_000, userId: 'user_route' },
    ]);
  });

  test('rejects invalid json, missing text, and text over 2000 characters', async () => {
    const { deps, classifyCalls } = dependencies();
    const post = createAlbatrossRoutePost(deps);
    expect((await post(request('{nope'))).status).toBe(400);
    expect((await post(request({}))).status).toBe(400);
    expect((await post(request({ text: '   ' }))).status).toBe(400);
    expect((await post(request({ text: 42 }))).status).toBe(400);
    const long = await post(request({ text: 'x'.repeat(2_001) }));
    expect(long.status).toBe(400);
    expect((await long.json()).error).toContain('2000');
    expect(classifyCalls).toHaveLength(0);
  });

  test('accepts text at exactly 2000 characters', async () => {
    const { deps } = dependencies();
    const response = await createAlbatrossRoutePost(deps)(request({ text: 'x'.repeat(2_000) }));
    expect(response.status).toBe(200);
  });

  test('maps auth and rate limit failures', async () => {
    const { deps } = dependencies();
    deps.requireCurrentUser = async () => {
      throw new AuthRequiredError('auth required');
    };
    expect((await createAlbatrossRoutePost(deps)(request({ text: 'hi there' }))).status).toBe(401);

    const limited = dependencies();
    limited.deps.enforceUserRateLimit = async () => {
      throw new RateLimitError('Too many requests.', 30_000, 60);
    };
    expect((await createAlbatrossRoutePost(limited.deps)(request({ text: 'hi there' }))).status).toBe(429);
  });

  test('reports a classifier crash as 500 instead of a false route', async () => {
    const { deps } = dependencies();
    deps.classifyRoute = async () => {
      throw new Error('boom');
    };
    const response = await createAlbatrossRoutePost(deps)(request({ text: 'hi there' }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: 'boom' });
  });
});
