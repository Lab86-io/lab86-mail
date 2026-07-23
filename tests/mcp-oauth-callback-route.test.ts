import { describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createMcpOAuthCallback } from '../app/api/mcp/oauth/callback/route';
import { getServerDef } from '../lib/mcp/servers';

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    convexMutation: async () => ({
      userId: 'user_1',
      server: 'granola',
      payloadEncrypted: 'payload',
      nativeCallback: false,
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
  test('redirects expired state instead of throwing a framework error', async () => {
    const callback = createMcpOAuthCallback(
      dependencies({
        convexMutation: async () => null,
      }),
    );

    const response = await callback(
      new NextRequest('http://localhost/api/mcp/oauth/callback?state=state_1&code=code_1'),
    );
    const location = response.headers.get('location') || '';

    expect(response.status).toBe(307);
    expect(location).toContain('mcp_error=OAuth+state+is+invalid+or+expired');
    expect(location).not.toContain('session');
  });

  test('returns native OAuth sessions to the app without requiring a browser cookie', async () => {
    const callback = createMcpOAuthCallback(
      dependencies({
        convexMutation: async () => ({
          userId: 'user_1',
          server: 'granola',
          payloadEncrypted: 'payload',
          nativeCallback: true,
        }),
      }),
    );
    const response = await callback(
      new NextRequest('http://localhost/api/mcp/oauth/callback?state=state_1&code=code_1'),
    );
    expect(response.headers.get('location')).toContain('lab86://oauth/connection?mcp_connected=Granola');
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
