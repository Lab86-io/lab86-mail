// Direct Google push: verification of the OIDC token that Cloud Pub/Sub
// sends with each push (`Authorization: Bearer <JWT>`).
//
// Pub/Sub signs the token with a Google key (RS256). The checks follow
// https://cloud.google.com/pubsub/docs/authenticate-push-subscriptions:
// - the signature matches a key from https://www.googleapis.com/oauth2/v3/certs;
// - `iss` is accounts.google.com;
// - `aud` is the audience of the push subscription;
// - `email` is the invoker service account, and `email_verified` is true;
// - the token is not expired, and it was not issued in the future.

import { createPublicKey, type KeyObject, verify } from 'node:crypto';

export const GOOGLE_OIDC_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
/** The clock difference that the time checks allow. */
export const OIDC_CLOCK_SKEW_MS = 60_000;
const DEFAULT_KEYS_TTL_MS = 60 * 60_000;
const MIN_KEYS_TTL_MS = 5 * 60_000;
const MAX_KEYS_TTL_MS = 24 * 60 * 60_000;
/** An unknown key id fetches the keys again, but not more often than this. */
const KEY_REFETCH_INTERVAL_MS = 60_000;
const MAX_TOKEN_LENGTH = 8192;

export interface PubSubPushExpectation {
  audience: string;
  serviceAccount: string;
}

export interface PubSubPushClaims {
  iss: string;
  aud: string;
  email: string;
  email_verified: boolean;
  exp: number;
  iat: number;
  sub?: string;
}

export type PubSubPushVerification =
  | { ok: true; claims: PubSubPushClaims }
  | {
      ok: false;
      reason:
        | 'missing'
        | 'malformed'
        | 'algorithm'
        | 'unknown_key'
        | 'signature'
        | 'issuer'
        | 'audience'
        | 'email'
        | 'expired'
        | 'not_yet_valid'
        | 'keys_unavailable';
    };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface VerifierDeps {
  fetch: FetchLike;
  now: () => number;
}

function decodeSegment(segment: string): any {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

function maxAgeMs(cacheControl: string | null): number {
  const seconds = Number(/max-age=(\d+)/i.exec(cacheControl || '')?.[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_KEYS_TTL_MS;
  return Math.min(MAX_KEYS_TTL_MS, Math.max(MIN_KEYS_TTL_MS, seconds * 1000));
}

/** The bearer token of an Authorization header, or null. */
export function bearerToken(header: string | null | undefined): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header || '');
  return match ? match[1] : null;
}

export function createPubSubPushVerifier(overrides: Partial<VerifierDeps> = {}) {
  const deps: VerifierDeps = {
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    ...overrides,
  };
  let keys = new Map<string, KeyObject>();
  let keysExpireAt = 0;
  let lastFetchAt = Number.NEGATIVE_INFINITY;
  let inflight: Promise<void> | null = null;

  async function loadKeys() {
    lastFetchAt = deps.now();
    const response = await deps.fetch(GOOGLE_OIDC_CERTS_URL, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Google certs answered ${response.status}.`);
    const body: any = await response.json();
    const next = new Map<string, KeyObject>();
    for (const jwk of Array.isArray(body?.keys) ? body.keys : []) {
      if (jwk?.kty !== 'RSA' || typeof jwk.kid !== 'string' || !jwk.n || !jwk.e) continue;
      try {
        next.set(jwk.kid, createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' }));
      } catch {
        // Skip a key that does not parse; the other keys still work.
      }
    }
    if (!next.size) throw new Error('Google certs had no RSA keys.');
    keys = next;
    keysExpireAt = deps.now() + maxAgeMs(response.headers.get('cache-control'));
  }

  async function refresh() {
    if (!inflight) {
      inflight = loadKeys().finally(() => {
        inflight = null;
      });
    }
    await inflight;
  }

  /** The key of a key id. Null for a key that Google does not publish. Throws when the keys cannot load. */
  async function keyFor(kid: string): Promise<KeyObject | null> {
    if (deps.now() >= keysExpireAt) await refresh();
    const key = keys.get(kid);
    if (key) return key;
    if (deps.now() - lastFetchAt < KEY_REFETCH_INTERVAL_MS) return null;
    await refresh();
    return keys.get(kid) ?? null;
  }

  return async function verifyPubSubPushToken(
    token: string | null | undefined,
    expected: PubSubPushExpectation,
  ): Promise<PubSubPushVerification> {
    if (!token) return { ok: false, reason: 'missing' };
    const parts = token.length <= MAX_TOKEN_LENGTH ? token.split('.') : [];
    if (parts.length !== 3 || parts.some((part) => !part)) return { ok: false, reason: 'malformed' };
    let header: any;
    let claims: any;
    try {
      header = decodeSegment(parts[0]);
      claims = decodeSegment(parts[1]);
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    if (!header || typeof header !== 'object' || !claims || typeof claims !== 'object') {
      return { ok: false, reason: 'malformed' };
    }
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return { ok: false, reason: 'algorithm' };
    let key: KeyObject | null;
    try {
      key = await keyFor(header.kid);
    } catch {
      return { ok: false, reason: 'keys_unavailable' };
    }
    if (!key) return { ok: false, reason: 'unknown_key' };
    const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
    const signature = Buffer.from(parts[2], 'base64url');
    let valid = false;
    try {
      valid = verify('sha256', signed, key, signature);
    } catch {
      valid = false;
    }
    if (!valid) return { ok: false, reason: 'signature' };
    if (!ISSUERS.has(claims.iss)) return { ok: false, reason: 'issuer' };
    if (typeof claims.aud !== 'string' || claims.aud !== expected.audience) {
      return { ok: false, reason: 'audience' };
    }
    if (
      typeof claims.email !== 'string' ||
      claims.email.toLowerCase() !== expected.serviceAccount.toLowerCase() ||
      claims.email_verified !== true
    ) {
      return { ok: false, reason: 'email' };
    }
    const now = deps.now();
    if (typeof claims.exp !== 'number' || claims.exp * 1000 + OIDC_CLOCK_SKEW_MS <= now) {
      return { ok: false, reason: 'expired' };
    }
    if (typeof claims.iat !== 'number' || claims.iat * 1000 - OIDC_CLOCK_SKEW_MS > now) {
      return { ok: false, reason: 'not_yet_valid' };
    }
    return { ok: true, claims: claims as PubSubPushClaims };
  };
}

export type PubSubPushVerifier = ReturnType<typeof createPubSubPushVerifier>;
