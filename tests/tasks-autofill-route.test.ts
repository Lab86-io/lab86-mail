import { describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createTaskAutofillPost } from '../app/api/tasks/autofill/route';
import { AuthRequiredError } from '../lib/auth/current-user';
import { RateLimitError } from '../lib/rate-limit';

const user = {
  userId: 'task_user',
  email: 'task@example.test',
  name: 'Task User',
  source: 'clerk' as const,
};

function request(body: unknown, timezone = 'America/Los_Angeles') {
  return new NextRequest('http://localhost/api/tasks/autofill', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-timezone': timezone },
    body: JSON.stringify(body),
  });
}

function dependencies() {
  return {
    requireCurrentUser: mock(async () => user),
    enforceUserRateLimit: mock(async () => ({ ok: true }) as any),
    generateObjectForCurrentUser: mock(async () => ({
      object: {
        title: 'File the report',
        description: '',
        priority: 'high',
        dueIso: '2026-01-02T07:30:00.000Z',
      },
    })) as any,
    now: () => new Date('2026-01-02T00:30:00.000Z'),
    reportUnexpectedError: mock(() => undefined),
  };
}

async function invoke(deps: ReturnType<typeof dependencies>, body: unknown, timezone?: string) {
  return createTaskAutofillPost(deps as any)(request(body, timezone));
}

describe('task autofill route', () => {
  test('rejects unauthenticated requests', async () => {
    const deps = dependencies();
    deps.requireCurrentUser.mockImplementation(async () => {
      throw new AuthRequiredError('Sign in required.');
    });

    const response = await invoke(deps, { rough: 'File this tomorrow' });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: 'Sign in required.' });
    expect(deps.generateObjectForCurrentUser).not.toHaveBeenCalled();
  });

  test('returns the shared rate-limit response', async () => {
    const deps = dependencies();
    deps.enforceUserRateLimit.mockImplementation(async () => {
      throw new RateLimitError('Slow down.', 2_100, 20);
    });

    const response = await invoke(deps, { rough: 'File this tomorrow' });

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('3');
    expect(await response.json()).toEqual({
      ok: false,
      error: 'Slow down.',
      retryAfterSeconds: 3,
      limit: 20,
    });
  });

  test('rejects empty rough input without calling AI', async () => {
    const deps = dependencies();

    const response = await invoke(deps, { rough: '   ' });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: 'Describe the task first.' });
    expect(deps.generateObjectForCurrentUser).not.toHaveBeenCalled();
  });

  test('formats the reference time in the validated client timezone across a UTC date boundary', async () => {
    const deps = dependencies();

    const response = await invoke(deps, { rough: 'File the report tomorrow at 11:30pm' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      draft: {
        title: 'File the report',
        description: '',
        priority: 'high',
        dueIso: '2026-01-02T07:30:00.000Z',
      },
    });
    const prompt = deps.generateObjectForCurrentUser.mock.calls[0][0].prompt;
    expect(prompt).toContain('Current time in America/Los_Angeles: Thursday, January 1, 2026');
    expect(prompt).toContain('16:30:00');
    expect(prompt).toContain('Rough task:\nFile the report tomorrow at 11:30pm');
  });

  test('falls back to UTC for an invalid timezone', async () => {
    const deps = dependencies();

    await invoke(deps, { rough: 'File tomorrow' }, 'not/a-timezone');

    const prompt = deps.generateObjectForCurrentUser.mock.calls[0][0].prompt;
    expect(prompt).toContain('Current time in UTC: Friday, January 2, 2026');
    expect(prompt).toContain('00:30:00');
  });

  test('returns a controlled failure for malformed AI output', async () => {
    const deps = dependencies();
    deps.generateObjectForCurrentUser.mockResolvedValue({ object: { title: '' } });

    const response = await invoke(deps, { rough: 'File tomorrow' });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: 'Autofill failed.' });
    expect(deps.reportUnexpectedError).toHaveBeenCalledTimes(1);
  });

  test('does not expose unexpected AI errors', async () => {
    const deps = dependencies();
    deps.generateObjectForCurrentUser.mockImplementation(async () => {
      throw new Error('private provider detail');
    });

    const response = await invoke(deps, { rough: 'File tomorrow' });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: 'Autofill failed.' });
    expect(deps.reportUnexpectedError).toHaveBeenCalledTimes(1);
  });
});
