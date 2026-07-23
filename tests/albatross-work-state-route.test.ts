import { describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createWorkStatePost } from '../app/api/albatross/work/[workId]/state/route';
import { AuthRequiredError } from '../lib/auth/current-user';
import { RateLimitError } from '../lib/rate-limit';

const user = {
  userId: 'work_state_user',
  email: 'work@example.test',
  name: 'Work User',
  source: 'clerk' as const,
};

function request(body: unknown) {
  return new NextRequest('http://localhost/api/albatross/work/work-1/state', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function dependencies() {
  return {
    requireCurrentUser: mock(async () => user),
    enforceUserRateLimit: mock(async () => ({ ok: true }) as any),
    updateWorkState: mock(async () => ({
      previousState: 'active' as const,
      state: 'paused' as const,
      ok: false,
      privateField: 'must not escape',
    })) as any,
    reportUnexpectedError: mock(() => undefined),
  };
}

async function invoke(deps: ReturnType<typeof dependencies>, body: unknown) {
  return createWorkStatePost(deps as any)(request(body), {
    params: Promise.resolve({ workId: 'work-1' }),
  });
}

describe('Albatross Work state route', () => {
  test('requires authentication', async () => {
    const deps = dependencies();
    deps.requireCurrentUser.mockImplementation(async () => {
      throw new AuthRequiredError('Sign in required.');
    });

    const response = await invoke(deps, { state: 'paused' });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: 'Sign in required.' });
  });

  test('returns the shared rate-limit response', async () => {
    const deps = dependencies();
    deps.enforceUserRateLimit.mockImplementation(async () => {
      throw new RateLimitError('Slow down.', 1_001, 60);
    });

    const response = await invoke(deps, { state: 'paused' });

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('2');
  });

  test('rejects malformed, unsupported, and non-string states', async () => {
    for (const state of [undefined, 'waiting', ['paused'], { value: 'paused' }, 1]) {
      const deps = dependencies();
      const response = await invoke(deps, { state });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ ok: false, error: 'invalid state' });
      expect(deps.updateWorkState).not.toHaveBeenCalled();
    }
  });

  test('passes only the validated state and returns a controlled success shape', async () => {
    const deps = dependencies();

    const response = await invoke(deps, { state: 'paused' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      previousState: 'active',
      state: 'paused',
    });
    expect(deps.updateWorkState).toHaveBeenCalledWith({
      userId: user.userId,
      workId: 'work-1',
      state: 'paused',
    });
  });

  test('does not expose unexpected mutation errors', async () => {
    const deps = dependencies();
    deps.updateWorkState.mockImplementation(async () => {
      throw new Error('private Convex detail');
    });

    const response = await invoke(deps, { state: 'paused' });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: 'State update failed.' });
    expect(deps.reportUnexpectedError).toHaveBeenCalledTimes(1);
  });
});
