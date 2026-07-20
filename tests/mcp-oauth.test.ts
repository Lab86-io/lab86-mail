import { describe, expect, test } from 'bun:test';
import {
  beginMcpOAuth,
  finishMcpOAuth,
  oauthExpiresAt,
  oauthScopes,
  refreshMcpOAuth,
} from '../lib/mcp/oauth';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function oauthFetch(tokenResponses: Array<Record<string, unknown>> = []) {
  const requests: Array<{ url: string; method: string; body: string }> = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method || (input instanceof Request ? input.method : 'GET');
    const body = String(init?.body || '');
    requests.push({ url, method, body });
    if (url.includes('oauth-protected-resource')) {
      return json({
        resource: 'https://mcp.test/mcp',
        authorization_servers: ['https://auth.test'],
        scopes_supported: ['mcp'],
      });
    }
    if (url.includes('.well-known/oauth-authorization-server')) {
      return json({
        issuer: 'https://auth.test',
        authorization_endpoint: 'https://auth.test/authorize',
        token_endpoint: 'https://auth.test/token',
        registration_endpoint: 'https://auth.test/register',
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (url === 'https://auth.test/register') {
      return json({
        client_id: 'client_123',
        client_name: 'Lab86 Mail',
        redirect_uris: ['http://127.0.0.1:18837/api/mcp/oauth/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      });
    }
    if (url === 'https://auth.test/token') {
      return json(
        tokenResponses.shift() || {
          access_token: 'access_1',
          refresh_token: 'refresh_1',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'mcp',
        },
      );
    }
    throw new Error(`Unexpected OAuth request: ${method} ${url}`);
  }) as typeof fetch;
  return { fetchFn, requests };
}

describe('hosted MCP OAuth', () => {
  test('discovers the server, dynamically registers, and starts PKCE authorization', async () => {
    const mock = oauthFetch();
    const started = await beginMcpOAuth({
      serverUrl: 'https://mcp.test/mcp',
      state: 'state_123',
      fetchFn: mock.fetchFn,
    });
    const authorization = new URL(started.authorizationUrl);

    expect(authorization.origin).toBe('https://auth.test');
    expect(authorization.searchParams.get('client_id')).toBe('client_123');
    expect(authorization.searchParams.get('state')).toBe('state_123');
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization.searchParams.get('code_challenge')).toBeTruthy();
    expect(started.persisted.codeVerifier).toBeTruthy();
    expect(started.persisted.clientInformation).toMatchObject({ client_id: 'client_123' });
    expect(mock.requests.some((request) => request.url === 'https://auth.test/register')).toBe(true);
  });

  test('exchanges the callback code and refreshes the resulting token', async () => {
    const mock = oauthFetch([
      {
        access_token: 'access_1',
        refresh_token: 'refresh_1',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'mcp',
      },
      {
        access_token: 'access_2',
        token_type: 'Bearer',
        expires_in: 7200,
        scope: 'mcp',
      },
    ]);
    const started = await beginMcpOAuth({
      serverUrl: 'https://mcp.test/mcp',
      state: 'state_456',
      fetchFn: mock.fetchFn,
    });
    const completed = await finishMcpOAuth({
      serverUrl: 'https://mcp.test/mcp',
      code: 'code_123',
      persisted: started.persisted,
      fetchFn: mock.fetchFn,
    });
    expect(completed.tokens).toMatchObject({ access_token: 'access_1', refresh_token: 'refresh_1' });

    const refreshed = await refreshMcpOAuth({
      serverUrl: 'https://mcp.test/mcp',
      persisted: completed,
      fetchFn: mock.fetchFn,
    });
    expect(refreshed.tokens).toMatchObject({ access_token: 'access_2', refresh_token: 'refresh_1' });
    const tokenBodies = mock.requests
      .filter((request) => request.url === 'https://auth.test/token')
      .map((request) => request.body);
    expect(tokenBodies[0]).toContain('grant_type=authorization_code');
    expect(tokenBodies[1]).toContain('grant_type=refresh_token');
  });

  test('derives expiry and scopes without inventing either', () => {
    expect(oauthExpiresAt({ access_token: 'a', token_type: 'Bearer', expires_in: 60 }, 1_000)).toBe(61_000);
    expect(oauthExpiresAt({ access_token: 'a', token_type: 'Bearer' }, 1_000)).toBeUndefined();
    expect(oauthScopes({ access_token: 'a', token_type: 'Bearer', scope: 'mcp profile' })).toEqual([
      'mcp',
      'profile',
    ]);
    expect(oauthScopes({ access_token: 'a', token_type: 'Bearer' }, ['mcp'])).toEqual(['mcp']);
  });
});
