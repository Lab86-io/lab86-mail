// Browser sign-in for sources whose OAuth apps we register ourselves
// (Atlassian, Bitbucket, Slack). These providers have no dynamic client
// registration for our use, so each one uses a fixed client id and secret
// from the environment. A provider without both variables stays on the
// token form, so the sign-in ships dark until the owner adds its app.

import { Buffer } from 'node:buffer';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { truncateText } from '../shared/text';
import { mcpOAuthRedirectUri, type PersistedMcpOAuthState } from './oauth';

export type ProviderOAuthId = 'atlassian' | 'bitbucket' | 'slack';

const PROVIDER_REQUEST_TIMEOUT_MS = 15_000;

interface ProviderOAuthEndpoint {
  label: string;
  authorizationUrl: string;
  tokenUrl: string;
  /** Bitbucket fixes the scopes on the consumer, so it sends none. */
  scopeParam?: 'scope' | 'user_scope';
  scopeSeparator?: ' ' | ',';
  scopes: string[];
  extraAuthorizationParams?: Record<string, string>;
  /** Atlassian takes a JSON body; Bitbucket and Slack take a form with Basic client auth. */
  tokenRequest: 'json' | 'form-basic';
  env: { clientId: string; clientSecret: string };
}

export const PROVIDER_OAUTH: Record<ProviderOAuthId, ProviderOAuthEndpoint> = {
  atlassian: {
    label: 'Atlassian',
    authorizationUrl: 'https://auth.atlassian.com/authorize',
    tokenUrl: 'https://auth.atlassian.com/oauth/token',
    scopeParam: 'scope',
    scopeSeparator: ' ',
    // Read only. offline_access returns the rotating refresh token.
    scopes: [
      'read:jira-work',
      'read:jira-user',
      'read:confluence-content.summary',
      'search:confluence',
      'read:me',
      'offline_access',
    ],
    extraAuthorizationParams: { audience: 'api.atlassian.com', prompt: 'consent' },
    tokenRequest: 'json',
    env: { clientId: 'ATLASSIAN_OAUTH_CLIENT_ID', clientSecret: 'ATLASSIAN_OAUTH_CLIENT_SECRET' },
  },
  bitbucket: {
    label: 'Bitbucket',
    authorizationUrl: 'https://bitbucket.org/site/oauth2/authorize',
    tokenUrl: 'https://bitbucket.org/site/oauth2/access_token',
    scopes: [],
    tokenRequest: 'form-basic',
    env: { clientId: 'BITBUCKET_OAUTH_KEY', clientSecret: 'BITBUCKET_OAUTH_SECRET' },
  },
  slack: {
    label: 'Slack',
    authorizationUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    // A user token only, read only: the app reads what the signed-in member
    // can see (public and private channels, direct and group messages), and
    // installs no bot.
    scopeParam: 'user_scope',
    scopeSeparator: ',',
    scopes: [
      'search:read',
      'users:read',
      'channels:read',
      'groups:read',
      'im:read',
      'mpim:read',
      'channels:history',
      'groups:history',
      'im:history',
      'mpim:history',
    ],
    tokenRequest: 'form-basic',
    env: { clientId: 'SLACK_OAUTH_CLIENT_ID', clientSecret: 'SLACK_OAUTH_CLIENT_SECRET' },
  },
};

/** The client information saved beside provider tokens; it marks the refresh path. */
export interface ProviderClientInformation {
  client_id: string;
  provider: ProviderOAuthId;
}

export function isProviderClientInformation(value: unknown): value is ProviderClientInformation {
  const provider = (value as { provider?: unknown })?.provider;
  return (
    typeof (value as { client_id?: unknown })?.client_id === 'string' &&
    typeof provider === 'string' &&
    provider in PROVIDER_OAUTH
  );
}

export function providerOAuthCredentials(
  provider: ProviderOAuthId,
  env: Record<string, string | undefined> = process.env,
): { clientId: string; clientSecret: string } | null {
  const names = PROVIDER_OAUTH[provider].env;
  const clientId = env[names.clientId]?.trim();
  const clientSecret = env[names.clientSecret]?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function providerOAuthConfigured(
  provider: ProviderOAuthId,
  env: Record<string, string | undefined> = process.env,
) {
  return providerOAuthCredentials(provider, env) !== null;
}

function requireCredentials(provider: ProviderOAuthId) {
  const credentials = providerOAuthCredentials(provider);
  if (!credentials) throw new Error(`${PROVIDER_OAUTH[provider].label} sign-in is not configured.`);
  return credentials;
}

export function buildProviderAuthorizationUrl(input: {
  provider: ProviderOAuthId;
  clientId: string;
  state: string;
  redirectUri?: string;
}) {
  const endpoint = PROVIDER_OAUTH[input.provider];
  const url = new URL(endpoint.authorizationUrl);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', input.redirectUri || mcpOAuthRedirectUri());
  url.searchParams.set('state', input.state);
  if (endpoint.scopeParam && endpoint.scopes.length) {
    url.searchParams.set(endpoint.scopeParam, endpoint.scopes.join(endpoint.scopeSeparator || ' '));
  }
  for (const [key, value] of Object.entries(endpoint.extraAuthorizationParams || {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export function beginProviderOAuth(input: { provider: ProviderOAuthId; state: string }) {
  const credentials = requireCredentials(input.provider);
  const persisted: PersistedMcpOAuthState = { state: input.state, provider: input.provider };
  return {
    authorizationUrl: buildProviderAuthorizationUrl({
      provider: input.provider,
      clientId: credentials.clientId,
      state: input.state,
    }),
    persisted,
  };
}

function numberOrUndefined(value: unknown) {
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) && number > 0 ? number : undefined;
}

function scopeText(value: unknown) {
  if (typeof value === 'string') return value.replaceAll(',', ' ');
  // Bitbucket answered `scopes` before its 2026-05-04 change.
  return undefined;
}

/**
 * The provider answer as standard OAuth tokens. Slack puts a user token
 * under `authed_user` and reports a failure with `ok: false` and HTTP 200.
 */
export function normalizeProviderTokens(provider: ProviderOAuthId, body: any): OAuthTokens {
  if (provider === 'slack' && body?.ok === false) {
    throw Object.assign(new Error(`Slack sign-in failed: ${String(body.error || 'unknown error')}`), {
      oauthError: String(body.error || ''),
    });
  }
  const source = provider === 'slack' && body?.authed_user?.access_token ? body.authed_user : body;
  const accessToken = typeof source?.access_token === 'string' ? source.access_token.trim() : '';
  if (!accessToken) throw new Error(`${PROVIDER_OAUTH[provider].label} did not return an access token.`);
  const refreshToken = typeof source.refresh_token === 'string' ? source.refresh_token.trim() : '';
  const expiresIn = numberOrUndefined(source.expires_in);
  const scope = scopeText(source.scope) ?? scopeText(source.scopes);
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
    ...(expiresIn ? { expires_in: expiresIn } : {}),
    ...(scope ? { scope } : {}),
  };
}

/** The account that a token answer names: a Slack sign-in reaches one workspace member. */
export function providerAccount(
  provider: ProviderOAuthId,
  body: any,
): { id: string; name?: string } | undefined {
  if (provider !== 'slack') return undefined;
  const teamId = typeof body?.team?.id === 'string' ? body.team.id.trim() : '';
  const userId = typeof body?.authed_user?.id === 'string' ? body.authed_user.id.trim() : '';
  if (!teamId || !userId) return undefined;
  const name = typeof body.team.name === 'string' ? body.team.name.trim() : '';
  return { id: `${teamId}:${userId}`, ...(name ? { name } : {}) };
}

async function requestProviderTokens(input: {
  provider: ProviderOAuthId;
  grant: Record<string, string>;
  fetchFn?: typeof fetch;
}): Promise<{ tokens: OAuthTokens; body: any }> {
  const endpoint = PROVIDER_OAUTH[input.provider];
  const credentials = requireCredentials(input.provider);
  const headers: Record<string, string> = { accept: 'application/json' };
  let body: string;
  if (endpoint.tokenRequest === 'json') {
    headers['content-type'] = 'application/json';
    body = JSON.stringify({
      ...input.grant,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    });
  } else {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    headers.authorization = `Basic ${Buffer.from(
      `${credentials.clientId}:${credentials.clientSecret}`,
      'utf8',
    ).toString('base64')}`;
    body = new URLSearchParams(input.grant).toString();
  }
  const response = await (input.fetchFn || fetch)(endpoint.tokenUrl, {
    method: 'POST',
    headers,
    body,
    cache: 'no-store',
    signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
  });
  const text = await response.text().catch(() => '');
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const reason = parsed?.error_description || parsed?.error || truncateText(text.trim(), 200);
    throw Object.assign(
      new Error(`${endpoint.label} token request failed with HTTP ${response.status}: ${reason}`),
      { statusCode: response.status, oauthError: String(parsed?.error || '') },
    );
  }
  return { tokens: normalizeProviderTokens(input.provider, parsed), body: parsed };
}

export async function finishProviderOAuth(input: {
  provider: ProviderOAuthId;
  code: string;
  persisted: PersistedMcpOAuthState;
  fetchFn?: typeof fetch;
}): Promise<PersistedMcpOAuthState> {
  const credentials = requireCredentials(input.provider);
  const { tokens, body } = await requestProviderTokens({
    provider: input.provider,
    grant: {
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: mcpOAuthRedirectUri(),
    },
    fetchFn: input.fetchFn,
  });
  const clientInformation: ProviderClientInformation = {
    client_id: credentials.clientId,
    provider: input.provider,
  };
  const account = providerAccount(input.provider, body);
  return {
    ...input.persisted,
    provider: input.provider,
    tokens,
    clientInformation,
    ...(account ? { account } : {}),
  };
}

/**
 * Exchanges a refresh token. Atlassian and Bitbucket rotate refresh tokens,
 * so the caller must save the new one; a provider that sends none keeps the
 * old one.
 */
export async function refreshProviderOAuth(input: {
  provider: ProviderOAuthId;
  refreshToken: string;
  fetchFn?: typeof fetch;
}): Promise<OAuthTokens> {
  const { tokens } = await requestProviderTokens({
    provider: input.provider,
    grant: { grant_type: 'refresh_token', refresh_token: input.refreshToken },
    fetchFn: input.fetchFn,
  });
  return tokens.refresh_token ? tokens : { ...tokens, refresh_token: input.refreshToken };
}
