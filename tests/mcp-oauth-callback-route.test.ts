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
  test('rejects a missing state before consuming or exchanging anything', async () => {
    let consumed = false;
    const callback = createMcpOAuthCallback(
      dependencies({
        convexMutation: async () => {
          consumed = true;
          return null;
        },
      }),
    );

    const response = await callback(new NextRequest('http://localhost/api/mcp/oauth/callback?code=code_1'));

    expect(response.headers.get('location')).toContain('mcp_error=Missing+OAuth+state');
    expect(consumed).toBe(false);
  });

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

  test('preserves native callback mode for provider denial and a missing code', async () => {
    const deps = dependencies({
      convexMutation: async () => ({
        userId: 'user_1',
        server: 'granola',
        payloadEncrypted: 'payload',
        nativeCallback: true,
      }),
      finishMcpOAuth: async () => {
        throw new Error('token exchange must not run');
      },
    });
    const callback = createMcpOAuthCallback(deps);

    const denied = await callback(
      new NextRequest('http://localhost/api/mcp/oauth/callback?state=state_1&error=access_denied'),
    );
    const missingCode = await callback(
      new NextRequest('http://localhost/api/mcp/oauth/callback?state=state_1'),
    );

    expect(denied.headers.get('location')).toContain(
      'lab86://oauth/connection?mcp_error=Authorization+was+not+completed',
    );
    expect(missingCode.headers.get('location')).toContain(
      'lab86://oauth/connection?mcp_error=The+provider+did+not+return+an+authorization+code',
    );
  });

  test('preserves native callback mode after exchange and first-sync failures', async () => {
    const exchangeFailure = createMcpOAuthCallback(
      dependencies({
        convexMutation: async () => ({
          userId: 'user_1',
          server: 'granola',
          payloadEncrypted: 'payload',
          nativeCallback: true,
        }),
        finishMcpOAuth: async () => {
          throw new Error('private token failure');
        },
      }),
    );
    const syncFailure = createMcpOAuthCallback(
      dependencies({
        convexMutation: async () => ({
          userId: 'user_1',
          server: 'granola',
          payloadEncrypted: 'payload',
          nativeCallback: true,
        }),
        syncConnection: async () => ({ ok: false, error: 'private sync detail' }),
      }),
    );

    const exchange = await exchangeFailure(
      new NextRequest('http://localhost/api/mcp/oauth/callback?state=state_1&code=code_1'),
    );
    const sync = await syncFailure(
      new NextRequest('http://localhost/api/mcp/oauth/callback?state=state_1&code=code_1'),
    );

    expect(exchange.headers.get('location')).toContain(
      'lab86://oauth/connection?mcp_error=Could+not+complete+authorization',
    );
    expect(exchange.headers.get('location')).not.toContain('private');
    expect(sync.headers.get('location')).toContain(
      'lab86://oauth/connection?mcp_error=Connected%2C+but+the+first+sync+failed',
    );
    expect(sync.headers.get('location')).not.toContain('private');
  });
});
