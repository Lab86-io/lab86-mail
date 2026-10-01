// Direct Google transport: access tokens.
//
// - The refresh token lives encrypted in `providerGrants.refreshTokenEncrypted`
//   on the one row whose `grantId` is the direct grant id (`google:<UUID>`).
// - `getGoogleAccessToken` returns a live access token. It caches the token in
//   memory until shortly before it expires, and it refreshes through
//   https://oauth2.googleapis.com/token with the Google OAuth client.
// - On `invalid_grant` it marks the account as needing a reconnect (the same
//   state a dead Nylas grant gets) and throws a GoogleApiError with status 401.
// - `invalidateGoogleAccessToken` drops the cached token, so the next call
//   refreshes.
// - Each refresh stores the identifiers of the refresh token, and, once, the
//   Google account id (`sub`) of a grant from before that field. Google
//   Cross-Account Protection events name an account or a token by these
//   (lib/google/risc.ts).

import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { markGrantNeedsReconnect } from '@/lib/nylas/grant-health';
import { decryptSecret, encryptSecret } from '@/lib/security/crypto';
import { GoogleApiError } from './errors';
import { fetchGoogleUserInfo, refreshGoogleAccessToken, subFromIdToken } from './oauth';
import { refreshTokenIdentifiers } from './token-identifiers';
import { isGoogleDirectGrant } from './transport';

/** A token is refreshed this long before Google says it expires. */
const EARLY_REFRESH_MS = 2 * 60_000;
const CACHE_MAX_ENTRIES = 1000;

export interface GoogleGrantCredentials {
  userId: string;
  accountId: string;
  email: string;
  scopes: string[];
  accessTokenEncrypted?: string;
  refreshTokenEncrypted?: string;
  expiresAt?: number;
  previousNylasGrantId?: string;
  googleSub?: string;
}

const defaults = {
  query: convexQuery,
  mutate: convexMutation,
  encryptSecret,
  decryptSecret,
  refreshGoogleAccessToken,
  fetchGoogleUserInfo: (accessToken: string) => fetchGoogleUserInfo(accessToken),
  markGrantNeedsReconnect,
  now: () => Date.now(),
};

let deps = defaults;
const cache = new Map<string, { token: string; expiresAt: number }>();
const inflight = new Map<string, Promise<string>>();
// Grants whose stored access token Google refused: skip it on the next load.
const refused = new Set<string>();

export function __setGoogleTokenDepsForTest(overrides: Partial<typeof defaults> = {}) {
  deps = { ...defaults, ...overrides };
  cache.clear();
  inflight.clear();
  refused.clear();
}

/** The encrypted token row of a direct grant, or null. */
export async function loadGoogleGrantCredentials(grantId: string): Promise<GoogleGrantCredentials | null> {
  return await deps.query<GoogleGrantCredentials | null>(api.googleDirect.getGrantCredentials, { grantId });
}

function remember(grantId: string, token: string, expiresAt: number) {
  if (!cache.has(grantId) && cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(grantId, { token, expiresAt });
}

const SIGN_IN_EXPIRED = 'the mailbox sign-in expired';

async function reconnectNeeded(grantId: string, detail: string): Promise<never> {
  await deps.markGrantNeedsReconnect(grantId, SIGN_IN_EXPIRED);
  throw new GoogleApiError(401, `invalid_grant: ${detail}`, 'invalid_grant');
}

async function load(grantId: string): Promise<string> {
  const credentials = await loadGoogleGrantCredentials(grantId);
  if (!credentials?.refreshTokenEncrypted) {
    return await reconnectNeeded(grantId, 'no Google sign-in is stored for this mailbox.');
  }
  const now = deps.now();
  if (
    !refused.has(grantId) &&
    credentials.accessTokenEncrypted &&
    typeof credentials.expiresAt === 'number' &&
    credentials.expiresAt - EARLY_REFRESH_MS > now
  ) {
    const token = deps.decryptSecret(credentials.accessTokenEncrypted);
    remember(grantId, token, credentials.expiresAt);
    return token;
  }
  let refreshed: Awaited<ReturnType<typeof refreshGoogleAccessToken>>;
  const refreshToken = deps.decryptSecret(credentials.refreshTokenEncrypted);
  try {
    refreshed = await deps.refreshGoogleAccessToken({ refreshToken });
  } catch (err) {
    if ((err as GoogleApiError)?.reason === 'invalid_grant') {
      return await reconnectNeeded(grantId, 'the Google sign-in expired or was revoked.');
    }
    throw err;
  }
  refused.delete(grantId);
  const expiresAt = deps.now() + Math.max(60, Number(refreshed.expires_in) || 3600) * 1000;
  remember(grantId, refreshed.access_token, expiresAt);
  const googleSub = credentials.googleSub ? undefined : await backfillSub(refreshed);
  // Other instances read the stored token. A failed write costs one extra
  // refresh there, so it does not fail this call.
  await deps
    .mutate(api.googleDirect.saveGrantAccessToken, {
      userId: credentials.userId,
      accountId: credentials.accountId,
      grantId,
      accessTokenEncrypted: deps.encryptSecret(refreshed.access_token),
      expiresAt,
      ...(refreshed.refresh_token
        ? { refreshTokenEncrypted: deps.encryptSecret(refreshed.refresh_token) }
        : {}),
      ...refreshTokenIdentifiers(refreshed.refresh_token || refreshToken),
      ...(googleSub ? { googleSub } : {}),
    })
    .catch((err: any) =>
      console.warn('[google-tokens] could not store the access token', err?.message || err),
    );
  return refreshed.access_token;
}

/**
 * The Google account id of a grant from before `googleSub`: from the ID token
 * of the refresh, or else from the userinfo endpoint. Undefined when neither
 * gives it; the next refresh tries again.
 */
async function backfillSub(refreshed: { access_token: string; id_token?: string }) {
  const fromToken = subFromIdToken(refreshed.id_token);
  if (fromToken) return fromToken;
  const info = await deps.fetchGoogleUserInfo(refreshed.access_token).catch(() => null);
  return info?.sub;
}

export async function getGoogleAccessToken(grantId: string): Promise<string> {
  if (!isGoogleDirectGrant(grantId)) throw new GoogleApiError(400, 'Not a direct Google grant id.');
  const cached = cache.get(grantId);
  if (cached && cached.expiresAt - EARLY_REFRESH_MS > deps.now()) return cached.token;
  let pending = inflight.get(grantId);
  if (!pending) {
    pending = load(grantId).finally(() => inflight.delete(grantId));
    inflight.set(grantId, pending);
  }
  return await pending;
}

/** Drops the cached token after Google refused it, so the next call refreshes. */
export function invalidateGoogleAccessToken(grantId: string): void {
  cache.delete(grantId);
  refused.add(grantId);
}

/** Forgets a grant completely (after a revoke or a rollback). */
export function forgetGoogleAccessToken(grantId: string): void {
  cache.delete(grantId);
  refused.delete(grantId);
}
