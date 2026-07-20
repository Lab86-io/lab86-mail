import { describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createMcpOAuthCallback } from '../app/api/mcp/oauth/callback/route';
import { getServerDef } from '../lib/mcp/servers';

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    requireCurrentUser: async () => ({ userId: 'user_1', email: 'user@example.com', name: 'User' }) as any,
    convexMutation: async () => ({
      server: 'granola',
      payloadEncrypted: 'payload',
    }),
    getServerDef,
    decryptSecret: () => JSON.stringify({ state: 'state_1' }),
    finishMcpOAuth: async ({ persisted }: any) => ({
      ...persisted,
      clientInformation: { client_id: 'client_1' },
      tokens: { access_token: 'access_1', token_type: 'Bearer' },
    }),
    saveOAuthConnection: async () => ({ connectionId: 'granola_1' }),
    syncConnection: async () => ({ ok: true, count: 1 }),
    ...overrides,
  } as any;
}

describe('MCP OAuth callback', () => {
  test('redirects expired sessions instead of throwing a framework error', async () => {
    const callback = createMcpOAuthCallback(
      dependencies({
        requireCurrentUser: async () => {
          throw new Error('session cookie details');
        },
      }),
    );

    const response = await callback(
      new NextRequest('http://localhost/api/mcp/oauth/callback?state=state_1&code=code_1'),
    );
    const location = response.headers.get('location') || '';

    expect(response.status).toBe(307);
    expect(location).toContain('mcp_error=Could+not+complete+authorization');
    expect(location).not.toContain('session+cookie+details');
  });

  test('never reflects raw provider errors into the settings redirect', async () => {
    const callback = createMcpOAuthCallback(dependencies());
    const response = await callback(
      new NextRequest(
        'http://localhost/api/mcp/oauth/callback?state=state_1&error_description=private_provider_detail',
      ),
    );
    const location = response.headers.get('location') || '';

    expect(location).toContain('mcp_error=Authorization+was+not+completed');
    expect(location).not.toContain('private_provider_detail');
  });
});
