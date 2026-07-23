import { describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createComposeDraftPost } from '../app/api/compose/draft/route';
import { AuthRequiredError } from '../lib/auth/current-user';
import { RateLimitError } from '../lib/rate-limit';

const user = {
  userId: 'compose_user',
  email: 'compose@example.test',
  name: 'Compose User',
  source: 'clerk' as const,
};

function request(body: unknown) {
  return new NextRequest('http://localhost/api/compose/draft', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function dependencies() {
  return {
    requireCurrentUser: mock(async () => user),
    enforceUserRateLimit: mock(async () => ({ ok: true }) as any),
    runWithAiRequestContext: mock(async (_context: unknown, run: () => Promise<unknown>) => run()) as any,
    generateTextForCurrentUser: mock(async () => ({ text: 'Hello from Albatross.' })) as any,
    reportUnexpectedError: mock(() => undefined),
  };
}

async function invoke(deps: ReturnType<typeof dependencies>, body: unknown) {
  return createComposeDraftPost(deps as any)(request(body));
}

describe('compose draft route', () => {
  test('requires authentication', async () => {
    const deps = dependencies();
    deps.requireCurrentUser.mockImplementation(async () => {
      throw new AuthRequiredError('Sign in required.');
    });

    const response = await invoke(deps, { instructions: 'Say hello' });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: 'Sign in required.' });
    expect(deps.generateTextForCurrentUser).not.toHaveBeenCalled();
  });

  test('uses the shared rate-limit response', async () => {
    const deps = dependencies();
    deps.enforceUserRateLimit.mockImplementation(async () => {
      throw new RateLimitError('Too many drafts.', 1_200, 20);
    });

    const response = await invoke(deps, { instructions: 'Say hello' });

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('2');
  });

  test('rejects an empty request before calling AI', async () => {
    const deps = dependencies();

    const response = await invoke(deps, { to: ' ', subject: '', instructions: '  ' });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'Add a recipient, subject, or drafting instruction first.',
    });
    expect(deps.generateTextForCurrentUser).not.toHaveBeenCalled();
  });

  test('returns editable generated body copy', async () => {
    const deps = dependencies();

    const response = await invoke(deps, {
      to: 'person@example.test',
      subject: 'Project',
      instructions: 'Ask for an update',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, draft: 'Hello from Albatross.' });
    expect(deps.runWithAiRequestContext).toHaveBeenCalledWith(
      expect.objectContaining({ userId: user.userId, userEmail: user.email }),
      expect.any(Function),
    );
    expect(deps.generateTextForCurrentUser.mock.calls[0][0].prompt).toContain(
      'Recipient: person@example.test',
    );
  });

  test('returns a 502 for empty AI output', async () => {
    const deps = dependencies();
    deps.generateTextForCurrentUser.mockResolvedValue({ text: '   ' });

    const response = await invoke(deps, { instructions: 'Say hello' });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'Albatross returned an empty draft.',
    });
  });

  test('does not expose unexpected AI failures', async () => {
    const deps = dependencies();
    deps.generateTextForCurrentUser.mockImplementation(async () => {
      throw new Error('private gateway failure');
    });

    const response = await invoke(deps, { instructions: 'Say hello' });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: 'Drafting failed.' });
    expect(deps.reportUnexpectedError).toHaveBeenCalledTimes(1);
  });
});
