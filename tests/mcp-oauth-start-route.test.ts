import { describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createMcpOAuthStartGet } from '../app/api/mcp/oauth/start/route';
import { AuthRequiredError } from '../lib/auth/current-user';
import { getServerDef } from '../lib/mcp/servers';

const user = {
  userId: 'mcp_user',
  email: 'mcp@example.test',
  name: 'MCP User',
  source: 'clerk' as const,
};

function request(query: string) {
  return new NextRequest(`http://localhost/api/mcp/oauth/start?${query}`);
}

function dependencies() {
  return {
    requireCurrentUser: async () => user,
    enforceUserRateLimit: async () => ({ ok: true }),
    getServerDef,
    beginMcpOAuth: mock(async () => ({
      authorizationUrl: 'https://provider.example.test/authorize',
      persisted: { state: 'state-1', verifier: 'verifier-1' },
    })) as any,
    saveOAuthState: mock(async () => ({ ok: true })),
    encryptSecret: (value: string) => `encrypted:${value}`,
    randomState: () => 'state-1',
    now: () => 1_000,
    reportUnexpectedError: mock(() => undefined),
  };
}

describe('MCP OAuth start route', () => {
  test('returns JSON authorization data and persists native callback mode', async () => {
    const deps = dependencies();

    const response = await createMcpOAuthStartGet(deps as any)(
      request('server=granola&format=json&native=1'),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      authorizationUrl: 'https://provider.example.test/authorize',
    });
    expect(deps.saveOAuthState.mock.calls[0][0]).toMatchObject({
      userId: user.userId,
      state: 'state-1',
      server: 'granola',
      nativeCallback: true,
      expiresAt: 601_000,
    });
  });

  test('returns machine-readable JSON when authorization setup fails', async () => {
    const beginFailure = dependencies();
    beginFailure.beginMcpOAuth.mockImplementation(async () => {
      throw new Error('private provider setup failure');
    });
    const saveFailure = dependencies();
    saveFailure.saveOAuthState.mockImplementation(async () => {
      throw new Error('private state persistence failure');
    });

    for (const deps of [beginFailure, saveFailure]) {
      const response = await createMcpOAuthStartGet(deps as any)(request('server=granola&format=json'));
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ ok: false, error: 'Could not start OAuth.' });
    }
  });

  test('keeps the browser failure redirect contract for non-JSON callers', async () => {
    const deps = dependencies();
    deps.beginMcpOAuth.mockImplementation(async () => {
      throw new Error('private provider setup failure');
    });

    const response = await createMcpOAuthStartGet(deps as any)(request('server=granola'));
    const location = response.headers.get('location') || '';

    expect(response.status).toBe(307);
    expect(location).toContain('/settings?mcp_error=Could+not+start+OAuth');
    expect(location).not.toContain('private');
    expect(deps.reportUnexpectedError).toHaveBeenCalledTimes(1);
  });

  test('returns a controlled authentication failure before OAuth setup', async () => {
    const deps = dependencies();
    deps.requireCurrentUser = async () => {
      throw new AuthRequiredError('Sign in required.');
    };

    const response = await createMcpOAuthStartGet(deps as any)(request('server=granola&format=json'));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: 'Sign in required.' });
    expect(deps.beginMcpOAuth).not.toHaveBeenCalled();
    expect(deps.reportUnexpectedError).not.toHaveBeenCalled();
  });
});
