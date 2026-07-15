import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { hostedPublicUrl } from '@/lib/hosted/env';

export interface PersistedMcpOAuthState {
  state: string;
  codeVerifier?: string;
  clientInformation?: OAuthClientInformationMixed;
  discoveryState?: OAuthDiscoveryState;
  tokens?: OAuthTokens;
}

class DurableOAuthProvider implements OAuthClientProvider {
  authorizationUrl?: string;

  constructor(
    private readonly redirect: URL,
    private readonly persisted: PersistedMcpOAuthState,
  ) {}

  get redirectUrl() {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Lab86 Mail',
      client_uri: hostedPublicUrl(),
      redirect_uris: [this.redirect.toString()],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'mcp',
    };
  }

  state() {
    return this.persisted.state;
  }

  clientInformation() {
    return this.persisted.clientInformation;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed) {
    this.persisted.clientInformation = clientInformation;
  }

  tokens() {
    return this.persisted.tokens;
  }

  saveTokens(tokens: OAuthTokens) {
    this.persisted.tokens = tokens;
  }

  redirectToAuthorization(authorizationUrl: URL) {
    this.authorizationUrl = authorizationUrl.toString();
  }

  saveCodeVerifier(codeVerifier: string) {
    this.persisted.codeVerifier = codeVerifier;
  }

  codeVerifier() {
    if (!this.persisted.codeVerifier) throw new Error('OAuth verifier is missing or expired.');
    return this.persisted.codeVerifier;
  }

  saveDiscoveryState(discoveryState: OAuthDiscoveryState) {
    this.persisted.discoveryState = discoveryState;
  }

  discoveryState() {
    return this.persisted.discoveryState;
  }
}

export function mcpOAuthRedirectUri() {
  return new URL('/api/mcp/oauth/callback', hostedPublicUrl()).toString();
}

export async function beginMcpOAuth(input: { serverUrl: string; state: string; fetchFn?: typeof fetch }) {
  const persisted: PersistedMcpOAuthState = { state: input.state };
  const provider = new DurableOAuthProvider(new URL(mcpOAuthRedirectUri()), persisted);
  const result = await auth(provider, { serverUrl: input.serverUrl, fetchFn: input.fetchFn });
  if (result !== 'REDIRECT' || !provider.authorizationUrl) {
    throw new Error('The MCP server did not start browser authorization.');
  }
  return { authorizationUrl: provider.authorizationUrl, persisted };
}

export async function finishMcpOAuth(input: {
  serverUrl: string;
  code: string;
  persisted: PersistedMcpOAuthState;
  fetchFn?: typeof fetch;
}) {
  const provider = new DurableOAuthProvider(new URL(mcpOAuthRedirectUri()), input.persisted);
  const result = await auth(provider, {
    serverUrl: input.serverUrl,
    authorizationCode: input.code,
    fetchFn: input.fetchFn,
  });
  if (result !== 'AUTHORIZED' || !input.persisted.tokens?.access_token) {
    throw new Error('The MCP server did not return an access token.');
  }
  return input.persisted;
}

export async function refreshMcpOAuth(input: {
  serverUrl: string;
  persisted: PersistedMcpOAuthState;
  fetchFn?: typeof fetch;
}) {
  const provider = new DurableOAuthProvider(new URL(mcpOAuthRedirectUri()), input.persisted);
  const result = await auth(provider, { serverUrl: input.serverUrl, fetchFn: input.fetchFn });
  if (result !== 'AUTHORIZED' || !input.persisted.tokens?.access_token) {
    throw new Error('MCP OAuth refresh requires the user to reconnect.');
  }
  return input.persisted;
}

export function oauthExpiresAt(tokens: OAuthTokens, now = Date.now()) {
  return tokens.expires_in ? now + Math.max(0, Number(tokens.expires_in)) * 1_000 : undefined;
}

export function oauthScopes(tokens: OAuthTokens, fallback: string[] = []) {
  return tokens.scope?.split(/\s+/u).filter(Boolean) || fallback;
}
