import { describe, expect, mock, test } from 'bun:test';
import type { NextRequest } from 'next/server';
import { createAreaBriefPost } from '../app/api/albatross/area/[areaId]/brief/route';
import { AuthRequiredError } from '../lib/auth/current-user';
import { RateLimitError } from '../lib/rate-limit';

const user = {
  userId: 'user_test',
  email: 'person@example.test',
  name: 'Person',
  source: 'clerk' as const,
};

function dependencies() {
  return {
    currentUser: mock(async () => user),
    rateLimit: mock(async () => ({ ok: true }) as any),
    areaExists: mock(async () => true),
    reindex: mock(async () => ({ ok: true })),
    generate: mock(async () => ({
      status: 'ready',
      lede: 'Current work is moving.',
      summary: 'Ready.',
    })) as any,
  };
}

async function invoke(deps: ReturnType<typeof dependencies>, areaId = 'area_test') {
  const post = createAreaBriefPost(deps as any);
  return post({} as NextRequest, { params: Promise.resolve({ areaId }) });
}

describe('Area brief refresh endpoint', () => {
  test('authenticates, rate-limits, reindexes, then generates from refreshed evidence', async () => {
    const deps = dependencies();
    let reindexFinished = false;
    deps.reindex.mockImplementation(async () => {
      reindexFinished = true;
      return { ok: true };
    });
    deps.generate.mockImplementation(async () => {
      expect(reindexFinished).toBe(true);
      return { status: 'ready', lede: 'Current work is moving.', summary: 'Ready.' };
    });

    const response = await invoke(deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      brief: { status: 'ready', lede: 'Current work is moving.', summary: 'Ready.' },
    });
    expect(deps.rateLimit).toHaveBeenCalledWith({
      userId: user.userId,
      key: 'albatross-area-brief',
      limit: 12,
      windowMs: 60_000,
    });
    expect(deps.areaExists).toHaveBeenCalledWith(user.userId, 'area_test');
  });

  test('returns controlled authentication and rate-limit responses', async () => {
    const unauthenticated = dependencies();
    unauthenticated.currentUser.mockImplementation(async () => {
      throw new AuthRequiredError('Sign in required.');
    });
    expect((await invoke(unauthenticated)).status).toBe(401);

    const limited = dependencies();
    limited.rateLimit.mockImplementation(async () => {
      throw new RateLimitError('Too many requests. Try again shortly.', 2_000, 12);
    });
    const limitedResponse = await invoke(limited);
    expect(limitedResponse.status).toBe(429);
    expect(limitedResponse.headers.get('retry-after')).toBe('2');
  });

  test('returns 404 only after an explicit owned-area lookup', async () => {
    const deps = dependencies();
    deps.areaExists.mockImplementation(async () => false);
    const response = await invoke(deps, 'missing_area');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, error: 'area not found' });
    expect(deps.reindex).not.toHaveBeenCalled();
    expect(deps.generate).not.toHaveBeenCalled();
  });

  test('rejects an empty area id before any Area work begins', async () => {
    const deps = dependencies();
    const response = await invoke(deps, '');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: 'area required' });
    expect(deps.areaExists).not.toHaveBeenCalled();
    expect(deps.reindex).not.toHaveBeenCalled();
    expect(deps.generate).not.toHaveBeenCalled();
  });

  test('keeps reindex best-effort and unknown generation failures client-safe', async () => {
    const withReindexFailure = dependencies();
    withReindexFailure.reindex.mockImplementation(async () => {
      throw new Error('classifier unavailable');
    });
    const originalWarn = console.warn;
    console.warn = mock(() => undefined);
    try {
      const response = await invoke(withReindexFailure);
      expect(response.status).toBe(200);
      expect(withReindexFailure.generate).toHaveBeenCalled();
      expect(await response.json()).toEqual({
        ok: true,
        brief: { status: 'ready', lede: 'Current work is moving.', summary: 'Ready.' },
      });
    } finally {
      console.warn = originalWarn;
    }

    const withSynchronousReindexFailure = dependencies();
    withSynchronousReindexFailure.reindex.mockImplementation(() => {
      throw new Error('synchronous classifier failure');
    });
    console.warn = mock(() => undefined);
    try {
      expect((await invoke(withSynchronousReindexFailure)).status).toBe(200);
      expect(withSynchronousReindexFailure.generate).toHaveBeenCalled();
    } finally {
      console.warn = originalWarn;
    }

    const withGenerationFailure = dependencies();
    withGenerationFailure.generate.mockImplementation(async () => {
      throw new Error('provider not found while generating');
    });
    const originalError = console.error;
    console.error = mock(() => undefined);
    try {
      const response = await invoke(withGenerationFailure);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ ok: false, error: 'brief refresh failed' });
    } finally {
      console.error = originalError;
    }
  });
});
