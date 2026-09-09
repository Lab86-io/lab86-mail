import { describe, expect, mock, spyOn, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createComposeDraftPost } from '../app/api/compose/draft/route';
import { AuthRequiredError } from '../lib/auth/current-user';
import { emptyNarrativeContext } from '../lib/narrative/context';
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
    context: mock(async () => ({
      ...emptyNarrativeContext('compose'),
      enabled: true,
      evidence: [
        {
          id: 'selected',
          title: 'Atlas',
          text: 'Decision: ship Friday',
          source: 'work',
          topics: [],
          trust: 'reported',
          occurredAt: 1,
          observedAt: 1,
        },
      ],
    })) as any,
  };
}

async function invoke(deps: ReturnType<typeof dependencies>, body: unknown) {
  return createComposeDraftPost(deps as any)(request(body));
}

describe('compose draft route', () => {
  test('cancellation before or during context lookup never starts generation', async () => {
    for (const cancelBefore of [true, false]) {
      const deps = dependencies();
      const controller = new AbortController();
      const req = new NextRequest('http://localhost/api/compose/draft', {
        method: 'POST',
        body: JSON.stringify({ instructions: 'Follow up', contextIds: ['selected'] }),
        signal: controller.signal,
      });
      if (cancelBefore) controller.abort();
      else
        deps.context.mockImplementation(async () => {
          controller.abort();
          return new Promise(() => {});
        });
      const response = await createComposeDraftPost(deps)(req);
      expect(response.status).toBe(499);
      expect(deps.generateTextForCurrentUser).not.toHaveBeenCalled();
      expect(deps.reportUnexpectedError).not.toHaveBeenCalled();
    }
  });
  test('one deadline covers generation and a stalled post-generation evidence recheck', async () => {
    const deps = dependencies();
    const deadline = new AbortController();
    const timeout = spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    try {
      const packet = await deps.context();
      let reads = 0;
      deps.context.mockImplementation(async () => {
        if (++reads === 1) return packet;
        deadline.abort(new DOMException('Timeout', 'TimeoutError'));
        return new Promise(() => {});
      });
      const response = await invoke(deps, {
        instructions: 'Follow up',
        contextIds: ['selected'],
        contextVersions: { selected: '' },
      });
      expect(response.status).toBe(504);
      expect(await response.text()).not.toContain('Hello from Albatross');
      expect(deps.generateTextForCurrentUser.mock.calls[0][0].abortSignal.aborted).toBe(true);
      expect(timeout).toHaveBeenCalledTimes(1);
    } finally {
      timeout.mockRestore();
    }
  });
  test('selected evidence is owned, bounded, rechecked, and never sent', async () => {
    const deps = dependencies();
    const response = await invoke(deps, {
      instructions: 'Follow up',
      contextIds: ['selected'],
      contextVersions: { selected: '' },
      userId: 'forged',
    });
    expect(response.status).toBe(200);
    expect(deps.context).toHaveBeenCalledTimes(2);
    expect(deps.context.mock.calls[0][0]).toBe(user.userId);
    expect(deps.context.mock.calls[0][2]).toBeInstanceOf(AbortSignal);
    expect(deps.context.mock.calls[0][1]).toMatchObject({ purpose: 'compose', evidenceIds: ['selected'] });
    expect(deps.generateTextForCurrentUser.mock.calls[0][0]).toMatchObject({
      userId: user.userId,
      maxRetries: 0,
      maxOutputTokens: 1800,
    });
    expect(deps.generateTextForCurrentUser.mock.calls[0][0].prompt).toContain('Decision: ship Friday');
    expect((await response.json()).context.sourceIds).toEqual(['selected']);
  });
  test('missing and revoked context fails closed before or after generation', async () => {
    const deps = dependencies();
    expect((await invoke(deps, { instructions: 'Follow up', contextIds: ['foreign'] })).status).toBe(409);
    expect(deps.generateTextForCurrentUser).not.toHaveBeenCalled();
    let reads = 0;
    const packet = await deps.context();
    deps.context.mockImplementation(async () => (++reads === 1 ? packet : emptyNarrativeContext('compose')));
    const response = await invoke(deps, {
      instructions: 'Follow up',
      contextIds: ['selected'],
      contextVersions: { selected: '' },
    });
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain('Hello from Albatross');
  });
  test('rejects malformed or oversized draft context', async () => {
    const deps = dependencies();
    for (const body of [
      { contextIds: Array(9).fill('id') },
      { instructions: 'x'.repeat(12001) },
      { to: 17 },
    ]) {
      expect((await invoke(deps, body)).status).toBe(400);
    }
    expect(deps.context).not.toHaveBeenCalled();
  });
  test('a corrected source must be selected again before being used in an outgoing draft', async () => {
    const deps = dependencies();
    const packet = await deps.context();
    deps.context.mockResolvedValue({
      ...packet,
      evidence: [{ ...packet.evidence[0], sourceVersion: 'new-version' }],
    });
    const response = await invoke(deps, {
      instructions: 'Follow up',
      contextIds: ['selected'],
      contextVersions: { selected: 'old-version' },
    });
    expect(response.status).toBe(409);
    expect(deps.generateTextForCurrentUser).not.toHaveBeenCalled();
  });
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
