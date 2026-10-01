// Direct Google transport: the OAuth client.
//
// One Google OAuth client serves Gmail, Calendar, and contacts. It is the
// Drive client of the same Google Cloud project as the Nylas Google connector
// (docs/google-direct-transport.md), unless GOOGLE_MAIL_CLIENT_ID and
// GOOGLE_MAIL_CLIENT_SECRET name another one. The redirect URI is the Files
// callback, which is registered on that client already.

import { createHash, randomBytes } from 'node:crypto';
import { cloudFileOAuthRedirectUri } from '@/lib/files/providers';
import { GoogleApiError } from './errors';

export const GOOGLE_AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

/** The owner decided these scopes. They equal the Nylas Google connector scopes. */
export const GOOGLE_MAIL_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/contacts.other.readonly',
  'https://www.googleapis.com/auth/directory.readonly',
] as const;

export const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';

const REQUEST_TIMEOUT_MS = 15_000;

type Env = Record<string, string | undefined>;
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GoogleOAuthClient {
  clientId: string;
  clientSecret: string;
}

export function googleOAuthClient(env: Env = process.env): GoogleOAuthClient | null {
  const mailId = env.GOOGLE_MAIL_CLIENT_ID?.trim();
  const mailSecret = env.GOOGLE_MAIL_CLIENT_SECRET?.trim();
  if (mailId && mailSecret) return { clientId: mailId, clientSecret: mailSecret };
  const driveId = env.GOOGLE_DRIVE_CLIENT_ID?.trim();
  const driveSecret = env.GOOGLE_DRIVE_CLIENT_SECRET?.trim();
  return driveId && driveSecret ? { clientId: driveId, clientSecret: driveSecret } : null;
}

export function requireGoogleOAuthClient(env: Env = process.env): GoogleOAuthClient {
  const client = googleOAuthClient(env);
  if (!client) throw new GoogleApiError(503, 'The Google OAuth client is not configured.');
  return client;
}

export function googleMailRedirectUri() {
  return cloudFileOAuthRedirectUri();
}

/** A PKCE verifier and its S256 challenge. */
export function pkcePair() {
  const codeVerifier = randomBytes(64).toString('base64url');
  return { codeVerifier, codeChallenge: createHash('sha256').update(codeVerifier).digest('base64url') };
}

export function buildGoogleMailAuthorizationUrl(input: {
  clientId: string;
  state: string;
  codeChallenge: string;
  loginHint?: string;
  redirectUri?: string;
}) {
  const url = new URL(GOOGLE_AUTHORIZATION_URL);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri || googleMailRedirectUri());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_MAIL_SCOPES.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  // No include_granted_scopes: mail and Drive share one OAuth client, and each
  // stored token must carry only the scopes of its own feature (commit faf5667d).
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (input.loginHint) url.searchParams.set('login_hint', input.loginHint);
  return url.toString();
}

export interface GoogleTokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  id_token?: string;
}

async function tokenEndpointError(response: Response): Promise<GoogleApiError> {
  let reason: string | undefined;
  let message = `Google token request failed with status ${response.status}.`;
  try {
    const body: any = await response.json();
    if (typeof body?.error === 'string') {
      reason = body.error;
      message = body.error_description ? `${body.error}: ${body.error_description}` : body.error;
    }
  } catch {
    // The body was not JSON; keep the default message.
  }
  // `invalid_grant` means the refresh token or code is dead: the grant is
  // gone, so the status is 401, the status a dead Nylas grant gives.
  return new GoogleApiError(reason === 'invalid_grant' ? 401 : response.status, message, reason);
}

async function postForm(fetcher: FetchLike, url: string, body: URLSearchParams) {
  return await fetcher(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

export async function exchangeGoogleAuthorizationCode(input: {
  code: string;
  codeVerifier: string;
  client?: GoogleOAuthClient;
  redirectUri?: string;
  fetch?: FetchLike;
}): Promise<GoogleTokenResponse> {
  const client = input.client ?? requireGoogleOAuthClient();
  const response = await postForm(
    input.fetch ?? fetch,
    GOOGLE_TOKEN_URL,
    new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri || googleMailRedirectUri(),
      grant_type: 'authorization_code',
    }),
  );
  if (!response.ok) throw await tokenEndpointError(response);
  const payload = (await response.json()) as GoogleTokenResponse;
  if (!payload?.access_token) throw new GoogleApiError(502, 'Google did not issue an access token.');
  return payload;
}

export async function refreshGoogleAccessToken(input: {
  refreshToken: string;
  client?: GoogleOAuthClient;
  fetch?: FetchLike;
}): Promise<GoogleTokenResponse> {
  const client = input.client ?? requireGoogleOAuthClient();
  const response = await postForm(
    input.fetch ?? fetch,
    GOOGLE_TOKEN_URL,
    new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: input.refreshToken,
      grant_type: 'refresh_token',
    }),
  );
  if (!response.ok) throw await tokenEndpointError(response);
  const payload = (await response.json()) as GoogleTokenResponse;
  if (!payload?.access_token) throw new GoogleApiError(502, 'Google did not issue an access token.');
  return payload;
}

/**
 * Revokes a token at Google. A 400 (`invalid_token`) means the token is gone
 * already, which is the goal, so it counts as success.
 */
export async function revokeGoogleToken(token: string, fetcher: FetchLike = fetch): Promise<boolean> {
  const response = await postForm(fetcher, GOOGLE_REVOKE_URL, new URLSearchParams({ token }));
  if (response.ok || response.status === 400) return true;
  throw new GoogleApiError(response.status, `Google token revoke returned ${response.status}.`);
}

/**
 * The Google account id (`sub`), name, and email of the signed-in Google
 * user, from the OpenID userinfo endpoint.
 */
export async function fetchGoogleUserInfo(
  accessToken: string,
  fetcher: FetchLike = fetch,
): Promise<{ sub?: string; email?: string; name?: string; emailVerified?: boolean }> {
  const response = await fetcher(GOOGLE_USERINFO_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new GoogleApiError(response.status, 'Could not read the Google account profile.');
  const body: any = await response.json().catch(() => ({}));
  return {
    sub: typeof body?.sub === 'string' && body.sub ? body.sub : undefined,
    email: typeof body?.email === 'string' ? body.email : undefined,
    name: typeof body?.name === 'string' ? body.name : undefined,
    emailVerified: typeof body?.email_verified === 'boolean' ? body.email_verified : undefined,
  };
}

/** The Gmail address and the current History id of the mailbox. */
export async function fetchGmailProfile(
  accessToken: string,
  fetcher: FetchLike = fetch,
): Promise<{ emailAddress: string; historyId: string }> {
  const response = await fetcher('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new GoogleApiError(response.status, 'Could not read the Gmail profile.');
  const body: any = await response.json().catch(() => ({}));
  if (typeof body?.emailAddress !== 'string' || !body?.historyId) {
    throw new GoogleApiError(502, 'The Gmail profile had no address or History id.');
  }
  return { emailAddress: body.emailAddress, historyId: String(body.historyId) };
}

export function grantedScopes(token: Pick<GoogleTokenResponse, 'scope'>): string[] {
  return [
    ...new Set(
      String(token.scope || '')
        .split(/\s+/)
        .map((scope) => scope.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * The Google account id (`sub`) in the ID token of a token response, or
 * undefined. The token came straight from Google's token endpoint over TLS,
 * so OpenID Connect Core 3.1.3.7 lets the client skip the signature check.
 * The issuer must still be Google.
 */
export function subFromIdToken(idToken: string | undefined | null): string | undefined {
  const payload = String(idToken || '').split('.')[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const issuer = String(claims?.iss || '').replace(/^https:\/\//, '');
    if (issuer !== 'accounts.google.com') return undefined;
    return typeof claims.sub === 'string' && claims.sub ? claims.sub : undefined;
  } catch {
    return undefined;
  }
}
