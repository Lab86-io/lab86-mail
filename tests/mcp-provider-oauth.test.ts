import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  beginProviderOAuth,
  buildProviderAuthorizationUrl,
  finishProviderOAuth,
  isProviderClientInformation,
  normalizeProviderTokens,
  providerOAuthConfigured,
  providerOAuthCredentials,
  refreshProviderOAuth,
} from '../lib/mcp/provider-oauth';

const ENV_KEYS = [
  'ATLASSIAN_OAUTH_CLIENT_ID',
  'ATLASSIAN_OAUTH_CLIENT_SECRET',
  'BITBUCKET_OAUTH_KEY',
  'BITBUCKET_OAUTH_SECRET',
  'SLACK_OAUTH_CLIENT_ID',
  'SLACK_OAUTH_CLIENT_SECRET',
  'LAB86_MAIL_PUBLIC_URL',
] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.LAB86_MAIL_PUBLIC_URL = 'https://mail.example.test';
  process.env.ATLASSIAN_OAUTH_CLIENT_ID = 'atl_client';
  process.env.ATLASSIAN_OAUTH_CLIENT_SECRET = 'atl_secret';
  process.env.BITBUCKET_OAUTH_KEY = 'bb_key';
  process.env.BITBUCKET_OAUTH_SECRET = 'bb_secret';
  process.env.SLACK_OAUTH_CLIENT_ID = 'slack_client';
  process.env.SLACK_OAUTH_CLIENT_SECRET = 'slack_secret';
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function tokenFetch(body: unknown, status = 200) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init: init || {} });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchFn, requests };
}

describe('provider OAuth configuration', () => {
  test('needs both the client id and the secret', () => {
    expect(providerOAuthConfigured('slack')).toBe(true);
    expect(providerOAuthCredentials('slack')).toEqual({
      clientId: 'slack_client',
      clientSecret: 'slack_secret',
    });
    expect(
      providerOAuthConfigured('slack', { SLACK_OAUTH_CLIENT_ID: 'id', SLACK_OAUTH_CLIENT_SECRET: ' ' }),
    ).toBe(false);
    expect(providerOAuthCredentials('atlassian', {})).toBeNull();
  });

  test('marks provider client information for the refresh path', () => {
    expect(isProviderClientInformation({ client_id: 'id', provider: 'bitbucket' })).toBe(true);
    expect(isProviderClientInformation({ client_id: 'id' })).toBe(false);
    expect(isProviderClientInformation({ client_id: 'id', provider: 'gitlab' })).toBe(false);
    expect(isProviderClientInformation(null)).toBe(false);
  });
});

describe('provider authorization URLs', () => {
  test('Atlassian asks for read scopes, offline access, and the API audience', () => {
    const url = new URL(
      buildProviderAuthorizationUrl({ provider: 'atlassian', clientId: 'atl_client', state: 'state_1' }),
    );
    expect(url.origin + url.pathname).toBe('https://auth.atlassian.com/authorize');
    expect(url.searchParams.get('audience')).toBe('api.atlassian.com');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('redirect_uri')).toBe('https://mail.example.test/api/mcp/oauth/callback');
    expect(url.searchParams.get('scope')?.split(' ')).toEqual([
      'read:jira-work',
      'read:jira-user',
      'read:confluence-content.summary',
      'search:confluence',
      'read:me',
      'offline_access',
    ]);
    expect(url.searchParams.get('state')).toBe('state_1');
  });

  test('Slack asks for user scopes only, and Bitbucket sends no scope', () => {
    const slack = new URL(buildProviderAuthorizationUrl({ provider: 'slack', clientId: 'c', state: 's' }));
    expect(slack.searchParams.get('user_scope')).toBe('search:read,users:read');
    expect(slack.searchParams.has('scope')).toBe(false);
    const bitbucket = new URL(
      buildProviderAuthorizationUrl({
        provider: 'bitbucket',
        clientId: 'c',
        state: 's',
        redirectUri: 'https://other.test/cb',
      }),
    );
    expect(bitbucket.origin + bitbucket.pathname).toBe('https://bitbucket.org/site/oauth2/authorize');
    expect(bitbucket.searchParams.has('scope')).toBe(false);
    expect(bitbucket.searchParams.get('redirect_uri')).toBe('https://other.test/cb');
  });

  test('begins with the configured client and marks the provider in the saved state', () => {
    const started = beginProviderOAuth({ provider: 'bitbucket', state: 'state_2' });
    expect(new URL(started.authorizationUrl).searchParams.get('client_id')).toBe('bb_key');
    expect(started.persisted).toEqual({ state: 'state_2', provider: 'bitbucket' });
  });

  test('refuses to begin when the provider app is not set', () => {
    delete process.env.SLACK_OAUTH_CLIENT_SECRET;
    expect(() => beginProviderOAuth({ provider: 'slack', state: 's' })).toThrow(
      'Slack sign-in is not configured.',
    );
  });
});

describe('provider token answers', () => {
  test('reads a Slack user token from authed_user', () => {
    expect(
      normalizeProviderTokens('slack', {
        ok: true,
        authed_user: {
          id: 'U1',
          access_token: 'xoxp-1',
          scope: 'search:read,users:read',
          token_type: 'user',
        },
      }),
    ).toEqual({ access_token: 'xoxp-1', token_type: 'Bearer', scope: 'search:read users:read' });
  });

  test('turns a Slack ok:false answer into an error', () => {
    expect(() => normalizeProviderTokens('slack', { ok: false, error: 'invalid_code' })).toThrow(
      'Slack sign-in failed: invalid_code',
    );
  });

  test('keeps refresh tokens and expiry, and rejects an empty token', () => {
    expect(
      normalizeProviderTokens('bitbucket', {
        access_token: ' bb-access ',
        refresh_token: 'bb-refresh',
        expires_in: '7200',
        scope: 'account pullrequest',
      }),
    ).toEqual({
      access_token: 'bb-access',
      token_type: 'Bearer',
      refresh_token: 'bb-refresh',
      expires_in: 7200,
      scope: 'account pullrequest',
    });
    expect(normalizeProviderTokens('atlassian', { access_token: 'a', expires_in: -1 })).toEqual({
      access_token: 'a',
      token_type: 'Bearer',
    });
    expect(() => normalizeProviderTokens('atlassian', {})).toThrow(
      'Atlassian did not return an access token.',
    );
  });
});

describe('provider token requests', () => {
  test('Atlassian exchanges the code with a JSON body and saves the client marker', async () => {
    const mock = tokenFetch({ access_token: 'atl_access', refresh_token: 'atl_refresh', expires_in: 3600 });
    const finished = await finishProviderOAuth({
      provider: 'atlassian',
      code: 'code_1',
      persisted: { state: 'state_1', provider: 'atlassian' },
      fetchFn: mock.fetchFn,
    });
    expect(mock.requests[0]?.url).toBe('https://auth.atlassian.com/oauth/token');
    expect(JSON.parse(String(mock.requests[0]?.init.body))).toEqual({
      grant_type: 'authorization_code',
      code: 'code_1',
      redirect_uri: 'https://mail.example.test/api/mcp/oauth/callback',
      client_id: 'atl_client',
      client_secret: 'atl_secret',
    });
    expect(finished.tokens).toMatchObject({ access_token: 'atl_access', refresh_token: 'atl_refresh' });
    expect(finished.clientInformation).toEqual({ client_id: 'atl_client', provider: 'atlassian' } as any);
  });

  test('Bitbucket and Slack send a form with Basic client authentication', async () => {
    const mock = tokenFetch({ ok: true, authed_user: { access_token: 'xoxp-2' } });
    await finishProviderOAuth({
      provider: 'slack',
      code: 'code_2',
      persisted: { state: 'state_2' },
      fetchFn: mock.fetchFn,
    });
    const headers = mock.requests[0]?.init.headers as Record<string, string>;
    expect(mock.requests[0]?.url).toBe('https://slack.com/api/oauth.v2.access');
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from('slack_client:slack_secret').toString('base64')}`,
    );
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(new URLSearchParams(String(mock.requests[0]?.init.body)).get('code')).toBe('code_2');
  });

  test('a refresh keeps the old refresh token when the provider sends none', async () => {
    const mock = tokenFetch({ access_token: 'new_access', expires_in: 7200 });
    const tokens = await refreshProviderOAuth({
      provider: 'bitbucket',
      refreshToken: 'old_refresh',
      fetchFn: mock.fetchFn,
    });
    expect(new URLSearchParams(String(mock.requests[0]?.init.body)).get('grant_type')).toBe('refresh_token');
    expect(tokens).toMatchObject({ access_token: 'new_access', refresh_token: 'old_refresh' });
  });

  test('reports the provider error with the HTTP status', async () => {
    const mock = tokenFetch({ error: 'invalid_grant', error_description: 'Refresh token expired' }, 400);
    const error = await refreshProviderOAuth({
      provider: 'atlassian',
      refreshToken: 'expired',
      fetchFn: mock.fetchFn,
    }).catch((err) => err);
    expect(error.message).toBe('Atlassian token request failed with HTTP 400: Refresh token expired');
    expect(error.statusCode).toBe(400);
    expect(error.oauthError).toBe('invalid_grant');

    const text = await refreshProviderOAuth({
      provider: 'atlassian',
      refreshToken: 'expired',
      fetchFn: tokenFetch('upstream down', 503).fetchFn,
    }).catch((err) => err);
    expect(text.message).toBe('Atlassian token request failed with HTTP 503: upstream down');
  });
});
