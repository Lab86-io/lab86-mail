import { createHash, randomBytes } from 'node:crypto';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { decryptSecret, encryptSecret } from '@/lib/security/crypto';
import {
  CLOUD_FILE_PROVIDER_DEFINITIONS,
  type CloudFileProvider,
  cloudFileOAuthRedirectUri,
  cloudFileProviderCredentials,
} from './providers';

const cloudFilesApi = (api as any).cloudFiles;

export interface CloudFileConnectionRow {
  connectionId: string;
  provider: CloudFileProvider;
  accountEmail?: string;
  displayName?: string;
  status: 'connected' | 'error';
  scopes: string[];
  lastAccessedAt?: number;
  error?: string;
}

interface StoredCloudFileConnection {
  connection: CloudFileConnectionRow;
  credentials: {
    accessTokenEncrypted: string;
    refreshTokenEncrypted?: string;
    expiresAt?: number;
  };
}

interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

const defaultDependencies = {
  convexMutation,
  convexQuery,
  decryptSecret,
  encryptSecret,
  fetch,
  now: Date.now,
};

let dependencies = defaultDependencies;

export function __setCloudFileConnectionDepsForTest(overrides: Partial<typeof defaultDependencies> = {}) {
  dependencies = { ...defaultDependencies, ...overrides };
}

function connectionIdFor(userId: string, provider: CloudFileProvider, accountKey: string) {
  const digest = createHash('sha256')
    .update(`${userId}:${provider}:${accountKey}`)
    .digest('hex')
    .slice(0, 16);
  return `${provider}_${digest}`;
}

export async function saveCloudFileOAuthState(input: {
  userId: string;
  provider: CloudFileProvider;
  redirectTo?: string;
  nativeCallback?: boolean;
}) {
  const state = randomBytes(32).toString('base64url');
  await dependencies.convexMutation(cloudFilesApi.saveOAuthState, {
    userId: input.userId,
    state,
    provider: input.provider,
    redirectTo: input.redirectTo,
    nativeCallback: input.nativeCallback,
    expiresAt: dependencies.now() + 10 * 60_000,
  });
  return state;
}

export async function consumeCloudFileOAuthState(state: string) {
  return dependencies.convexMutation<{
    userId: string;
    provider: CloudFileProvider;
    redirectTo?: string;
    nativeCallback?: boolean;
  } | null>(cloudFilesApi.consumeOAuthState, { state });
}

export async function exchangeCloudFileAuthorizationCode(input: {
  provider: CloudFileProvider;
  code: string;
}): Promise<OAuthTokenResponse> {
  const credentials = cloudFileProviderCredentials(input.provider);
  if (!credentials) {
    throw new Error(`${CLOUD_FILE_PROVIDER_DEFINITIONS[input.provider].label} is not configured.`);
  }
  const body = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    code: input.code,
    redirect_uri: cloudFileOAuthRedirectUri(),
    grant_type: 'authorization_code',
  });
  const response = await dependencies.fetch(CLOUD_FILE_PROVIDER_DEFINITIONS[input.provider].tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.access_token) {
    throw new Error('The provider did not issue file access credentials.');
  }
  return payload as OAuthTokenResponse;
}

async function cloudFileAccountProfile(provider: CloudFileProvider, accessToken: string) {
  const endpoint =
    provider === 'google_drive'
      ? 'https://www.googleapis.com/oauth2/v2/userinfo'
      : 'https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName';
  const response = await dependencies.fetch(endpoint, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error('Could not read the connected account profile.');
  if (provider === 'google_drive') {
    const email = typeof payload.email === 'string' ? payload.email : undefined;
    const id = typeof payload.id === 'string' ? payload.id : email || 'google-account';
    return {
      accountKey: id,
      accountEmail: email,
      displayName: typeof payload.name === 'string' ? payload.name : email || 'Google Drive',
    };
  }
  const email =
    typeof payload.mail === 'string'
      ? payload.mail
      : typeof payload.userPrincipalName === 'string'
        ? payload.userPrincipalName
        : undefined;
  return {
    accountKey: typeof payload.id === 'string' ? payload.id : email || 'microsoft-account',
    accountEmail: email,
    displayName: typeof payload.displayName === 'string' ? payload.displayName : email || 'OneDrive',
  };
}

export async function saveCloudFileConnection(input: {
  userId: string;
  provider: CloudFileProvider;
  tokens: OAuthTokenResponse;
}) {
  const profile = await cloudFileAccountProfile(input.provider, input.tokens.access_token);
  const connectionId = connectionIdFor(input.userId, input.provider, profile.accountKey);
  const scopes = input.tokens.scope
    ? input.tokens.scope.split(/\s+/u).filter(Boolean)
    : CLOUD_FILE_PROVIDER_DEFINITIONS[input.provider].scopes;
  const expiresAt =
    typeof input.tokens.expires_in === 'number'
      ? dependencies.now() + input.tokens.expires_in * 1_000
      : undefined;
  const result = await dependencies.convexMutation<{
    ok: boolean;
    connectionId: string;
  }>(cloudFilesApi.upsertConnection, {
    userId: input.userId,
    connectionId,
    provider: input.provider,
    accountKey: profile.accountKey,
    accountEmail: profile.accountEmail,
    displayName: profile.displayName,
    scopes,
    accessTokenEncrypted: dependencies.encryptSecret(input.tokens.access_token),
    refreshTokenEncrypted: input.tokens.refresh_token
      ? dependencies.encryptSecret(input.tokens.refresh_token)
      : undefined,
    expiresAt,
  });
  return { connectionId: result.connectionId || connectionId, ...profile };
}

export async function listCloudFileConnections(userId: string) {
  return dependencies.convexQuery<CloudFileConnectionRow[]>(cloudFilesApi.listConnections, { userId });
}

async function refreshCloudFileToken(input: {
  userId: string;
  row: StoredCloudFileConnection;
  refreshToken: string;
}) {
  const provider = input.row.connection.provider;
  const credentials = cloudFileProviderCredentials(provider);
  if (!credentials) throw new Error('Cloud file provider is not configured.');
  const body = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    refresh_token: input.refreshToken,
    grant_type: 'refresh_token',
  });
  if (provider === 'onedrive') {
    body.set('scope', CLOUD_FILE_PROVIDER_DEFINITIONS.onedrive.scopes.join(' '));
  }
  const response = await dependencies.fetch(CLOUD_FILE_PROVIDER_DEFINITIONS[provider].tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.access_token) {
    throw new Error('File access expired. Reconnect this account.');
  }
  const next = payload as OAuthTokenResponse;
  const expiresAt =
    typeof next.expires_in === 'number' ? dependencies.now() + next.expires_in * 1_000 : undefined;
  await dependencies.convexMutation(cloudFilesApi.updateCredentials, {
    userId: input.userId,
    connectionId: input.row.connection.connectionId,
    accessTokenEncrypted: dependencies.encryptSecret(next.access_token),
    refreshTokenEncrypted: next.refresh_token ? dependencies.encryptSecret(next.refresh_token) : undefined,
    expiresAt,
  });
  return next.access_token;
}

export async function getCloudFileAccess(input: { userId: string; connectionId: string }) {
  const row = await dependencies.convexQuery<StoredCloudFileConnection | null>(
    cloudFilesApi.getConnectionWithCredentials,
    input,
  );
  if (!row) return null;
  let accessToken = dependencies.decryptSecret(row.credentials.accessTokenEncrypted);
  if (row.credentials.expiresAt !== undefined && row.credentials.expiresAt <= dependencies.now() + 60_000) {
    if (!row.credentials.refreshTokenEncrypted) {
      throw new Error('File access expired. Reconnect this account.');
    }
    accessToken = await refreshCloudFileToken({
      userId: input.userId,
      row,
      refreshToken: dependencies.decryptSecret(row.credentials.refreshTokenEncrypted),
    });
  }
  return { connection: row.connection, accessToken };
}

export async function disconnectCloudFileConnection(userId: string, connectionId: string) {
  await dependencies.convexMutation(cloudFilesApi.disconnect, {
    userId,
    connectionId,
  });
}

export async function markCloudFileConnectionAccess(userId: string, connectionId: string, error?: string) {
  await dependencies.convexMutation(cloudFilesApi.markAccessed, {
    userId,
    connectionId,
    error,
  });
}
