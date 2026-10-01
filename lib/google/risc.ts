// Google Cross-Account Protection (RISC): the receiver of Security Event
// Tokens (docs/google-risc.md).
//
// Google sends a signed JWT (`application/secevent+jwt`) to
// /api/google/risc when it sees a security event on a Google account that
// gave access to our OAuth clients. This module:
//
// - verifies the token: an RS256 signature with a key from the `jwks_uri` of
//   https://accounts.google.com/.well-known/risc-configuration, the issuer,
//   an audience that is one of our OAuth client ids, and a recent `iat`.
//   Google says not to check `exp`: an event token tells of a past event.
// - reads each event into a short type, a subject (Google `sub`, email, or a
//   refresh token identifier), and the action that Albatross takes.
// - sends the events to Convex (googleSecurity:recordSecurityEvent). Convex
//   is idempotent by `jti`, finds the Google connections of the subject, and
//   applies the actions only when LAB86_GOOGLE_RISC=1. With the flag off it
//   records the event and the number of matches, and changes nothing.
//
// Albatross never revokes a token for these events: Google did that already.

import { createPublicKey, type KeyObject, verify as verifySignature } from 'node:crypto';
import { api, convexMutation } from '@/lib/hosted/convex';
import { normalizeBase64, refreshTokenPrefixHash } from './token-identifiers';
import { forgetGoogleAccessToken } from './tokens';

export const RISC_CONFIGURATION_URL = 'https://accounts.google.com/.well-known/risc-configuration';
export const GOOGLE_RISC_ISSUER = 'https://accounts.google.com';

const RISC = 'https://schemas.openid.net/secevent/risc/event-type/';
const OAUTH = 'https://schemas.openid.net/secevent/oauth/event-type/';

/** The event types that Albatross asks Google for (docs/google-risc.md). */
export const RISC_EVENT_TYPES = {
  'sessions-revoked': `${RISC}sessions-revoked`,
  'tokens-revoked': `${OAUTH}tokens-revoked`,
  'token-revoked': `${OAUTH}token-revoked`,
  'account-disabled': `${RISC}account-disabled`,
  'account-enabled': `${RISC}account-enabled`,
  'credential-change-required': `${RISC}account-credential-change-required`,
  verification: `${RISC}verification`,
} as const;

export type RiscEventName = keyof typeof RISC_EVENT_TYPES | 'account-purged' | 'unknown';

const EVENT_NAMES = new Map<string, RiscEventName>([
  ...Object.entries(RISC_EVENT_TYPES).map(([name, uri]) => [uri, name as RiscEventName] as const),
  [`${RISC}account-purged`, 'account-purged'],
]);

/**
 * What Albatross does for an event:
 * - `revoke`: delete the stored tokens, mark the connection "Reconnect needed".
 * - `hold`: the same, and set a security hold until `account-enabled`.
 * - `release`: clear the security hold. A reconnect is still necessary.
 * - `reconnect`: mark the connection "Reconnect needed". The tokens stay.
 * - `log`: record the event only.
 */
export type RiscAction = 'revoke' | 'hold' | 'release' | 'reconnect' | 'log';

export interface RiscSubject {
  sub?: string;
  email?: string;
  /** SHA-256 (hex) of the first 16 characters of a refresh token. */
  tokenPrefixHash?: string;
  /** base64(SHA-512(SHA-512(refresh token))): Google's `hash_base64_sha512_sha512`. */
  tokenDoubleHash?: string;
}

export interface RiscEvent {
  type: string;
  name: RiscEventName;
  action: RiscAction;
  reason?: string;
  state?: string;
  subject: RiscSubject;
}

export interface VerifiedSecurityEventToken {
  jti: string;
  iat: number;
  aud: string[];
  events: RiscEvent[];
}

/** RFC 8935 error codes, sent as `{ "err": code, "description": text }` with status 400. */
export type RiscErrorCode =
  | 'invalid_request'
  | 'invalid_key'
  | 'invalid_issuer'
  | 'invalid_audience'
  | 'authentication_failed';

export class SecurityEventTokenError extends Error {
  readonly code: RiscErrorCode;
  constructor(code: RiscErrorCode, message: string) {
    super(message);
    this.name = 'SecurityEventTokenError';
    this.code = code;
  }
}

/** Google's configuration or keys could not be read. The sender can try again later. */
export class RiscUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RiscUnavailableError';
  }
}

type Env = Record<string, string | undefined>;
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** A token may be this much in the future (clock skew). */
const FUTURE_SKEW_MS = 5 * 60_000;
/** The oldest token that the receiver accepts. Event rows (and their `jti`) stay 30 days. */
export const RISC_MAX_TOKEN_AGE_MS = 7 * 24 * 60 * 60_000;
const CONFIG_TTL_MS = 6 * 60 * 60_000;
const DEFAULT_JWKS_TTL_MS = 60 * 60_000;
const MIN_JWKS_TTL_MS = 5 * 60_000;
const MAX_JWKS_TTL_MS = 24 * 60 * 60_000;
/** An unknown key id loads the key set again, but not more often than this. */
const JWKS_REFRESH_GAP_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_TOKEN_BYTES = 16_384;

const defaults = {
  fetch: ((input: string, init?: RequestInit) => fetch(input, init)) as FetchLike,
  now: () => Date.now(),
  env: (): Env => process.env,
  mutate: convexMutation,
  forgetGoogleAccessToken,
};
let deps = defaults;

let configCache: { issuer: string; jwksUri: string; expiresAt: number } | null = null;
let jwksCache: { uri: string; keys: Map<string, KeyObject>; expiresAt: number; fetchedAt: number } | null =
  null;
let jwksInflight: Promise<Map<string, KeyObject>> | null = null;

export function __setRiscDepsForTest(overrides: Partial<typeof defaults> = {}) {
  deps = { ...defaults, ...overrides };
  configCache = null;
  jwksCache = null;
  jwksInflight = null;
}

/** RISC actions change data only when LAB86_GOOGLE_RISC is exactly 1. */
export function isRiscProcessingEnabled(env: Env = deps.env()): boolean {
  return env.LAB86_GOOGLE_RISC === '1';
}

/**
 * The OAuth client ids that a token may name in `aud`: the comma list in
 * LAB86_GOOGLE_RISC_AUDIENCES, or else the configured Google mail and Drive
 * client ids. An empty list makes every token fail.
 */
export function riscAudiences(env: Env = deps.env()): string[] {
  const listed = String(env.LAB86_GOOGLE_RISC_AUDIENCES || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const source = listed.length ? listed : [env.GOOGLE_MAIL_CLIENT_ID, env.GOOGLE_DRIVE_CLIENT_ID];
  return [
    ...new Set(source.map((value) => value?.trim()).filter((value): value is string => Boolean(value))),
  ];
}

/** The issuer without a trailing slash: Google's configuration and its tokens differ there. */
export function normalizeIssuer(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
}

function decodeSegment(segment: string, what: string): any {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw new SecurityEventTokenError('invalid_request', `The token ${what} is not base64url.`);
  }
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw new SecurityEventTokenError('invalid_request', `The token ${what} is not JSON.`);
  }
}

async function fetchJson(url: string, what: string): Promise<{ body: any; maxAgeMs: number | null }> {
  let response: Response;
  try {
    response = await deps.fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err: any) {
    throw new RiscUnavailableError(`Could not read the Google ${what}: ${err?.name || 'network error'}.`);
  }
  if (!response.ok) throw new RiscUnavailableError(`The Google ${what} returned ${response.status}.`);
  const body = await response.json().catch(() => null);
  if (!body || typeof body !== 'object') throw new RiscUnavailableError(`The Google ${what} is not JSON.`);
  const maxAge = /max-age=(\d+)/i.exec(response.headers.get('cache-control') || '')?.[1];
  return { body, maxAgeMs: maxAge ? Number(maxAge) * 1000 : null };
}

async function riscConfiguration() {
  const now = deps.now();
  if (configCache && configCache.expiresAt > now) return configCache;
  const { body } = await fetchJson(RISC_CONFIGURATION_URL, 'RISC configuration');
  const issuer = normalizeIssuer(body.issuer);
  const jwksUri = typeof body.jwks_uri === 'string' ? body.jwks_uri : '';
  // Fail closed: a configuration with another issuer or a key URI that is not
  // HTTPS is not Google's.
  if (issuer !== GOOGLE_RISC_ISSUER || !jwksUri.startsWith('https://')) {
    throw new RiscUnavailableError('The Google RISC configuration has an unexpected issuer or key URI.');
  }
  configCache = { issuer, jwksUri, expiresAt: now + CONFIG_TTL_MS };
  return configCache;
}

async function loadKeys(uri: string): Promise<Map<string, KeyObject>> {
  const { body, maxAgeMs } = await fetchJson(uri, 'signing keys');
  const keys = new Map<string, KeyObject>();
  for (const jwk of Array.isArray(body.keys) ? body.keys : []) {
    if (jwk?.kty !== 'RSA' || typeof jwk.kid !== 'string' || !jwk.n || !jwk.e) continue;
    if (jwk.alg && jwk.alg !== 'RS256') continue;
    if (jwk.use && jwk.use !== 'sig') continue;
    try {
      keys.set(jwk.kid, createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' }));
    } catch {
      // A key that does not load cannot verify a token; skip it.
    }
  }
  const now = deps.now();
  const ttl = Math.min(Math.max(maxAgeMs ?? DEFAULT_JWKS_TTL_MS, MIN_JWKS_TTL_MS), MAX_JWKS_TTL_MS);
  jwksCache = { uri, keys, expiresAt: now + ttl, fetchedAt: now };
  return keys;
}

async function keysFor(uri: string): Promise<Map<string, KeyObject>> {
  if (jwksInflight) return await jwksInflight;
  jwksInflight = loadKeys(uri).finally(() => {
    jwksInflight = null;
  });
  return await jwksInflight;
}

/** The public key for `kid`. An unknown id loads the key set again once (Google rotates keys). */
async function signingKey(uri: string, kid: string): Promise<KeyObject> {
  const now = deps.now();
  const cached = jwksCache?.uri === uri && jwksCache.expiresAt > now ? jwksCache : null;
  let key = cached?.keys.get(kid);
  if (key) return key;
  if (!cached || now - cached.fetchedAt >= JWKS_REFRESH_GAP_MS) key = (await keysFor(uri)).get(kid);
  if (!key) throw new SecurityEventTokenError('invalid_key', 'The token is signed with an unknown key.');
  return key;
}

function audienceList(aud: unknown): string[] {
  if (typeof aud === 'string') return [aud];
  if (Array.isArray(aud)) return aud.filter((value): value is string => typeof value === 'string');
  return [];
}

/**
 * Verifies a Security Event Token and returns its claims. Throws
 * SecurityEventTokenError for a bad token (answer 400) and
 * RiscUnavailableError when Google's keys cannot be read (answer 503).
 */
export async function verifySecurityEventToken(
  token: string,
  options: { audiences?: string[] } = {},
): Promise<VerifiedSecurityEventToken> {
  const compact = String(token || '').trim();
  if (!compact || compact.length > MAX_TOKEN_BYTES) {
    throw new SecurityEventTokenError('invalid_request', 'The request has no security event token.');
  }
  const parts = compact.split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new SecurityEventTokenError('invalid_request', 'The token is not a signed JWT.');
  }
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = decodeSegment(headerPart, 'header');
  if (header?.alg !== 'RS256') {
    throw new SecurityEventTokenError('invalid_request', 'The token must use RS256.');
  }
  if (typeof header.kid !== 'string' || !header.kid) {
    throw new SecurityEventTokenError('invalid_key', 'The token has no key id.');
  }
  const payload = decodeSegment(payloadPart, 'payload');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new SecurityEventTokenError('invalid_request', 'The token payload is not an object.');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(signaturePart)) {
    throw new SecurityEventTokenError('invalid_request', 'The token signature is not base64url.');
  }

  const config = await riscConfiguration();
  const key = await signingKey(config.jwksUri, header.kid);
  const signed = verifySignature(
    'RSA-SHA256',
    Buffer.from(`${headerPart}.${payloadPart}`),
    key,
    Buffer.from(signaturePart, 'base64url'),
  );
  if (!signed)
    throw new SecurityEventTokenError('authentication_failed', 'The token signature is not valid.');

  if (normalizeIssuer(payload.iss) !== config.issuer) {
    throw new SecurityEventTokenError('invalid_issuer', 'The token issuer is not Google.');
  }
  const allowed = options.audiences ?? riscAudiences();
  const aud = audienceList(payload.aud);
  if (!allowed.length || !aud.some((value) => allowed.includes(value))) {
    throw new SecurityEventTokenError('invalid_audience', 'The token is not for this app.');
  }
  const iat = Number(payload.iat);
  const now = deps.now();
  if (!Number.isFinite(iat) || iat <= 0) {
    throw new SecurityEventTokenError('invalid_request', 'The token has no issue time.');
  }
  if (iat * 1000 > now + FUTURE_SKEW_MS || iat * 1000 < now - RISC_MAX_TOKEN_AGE_MS) {
    throw new SecurityEventTokenError('invalid_request', 'The token issue time is not recent.');
  }
  const jti = typeof payload.jti === 'string' ? payload.jti.trim() : '';
  if (!jti || jti.length > 256) throw new SecurityEventTokenError('invalid_request', 'The token has no jti.');
  const events = payload.events;
  if (!events || typeof events !== 'object' || Array.isArray(events) || !Object.keys(events).length) {
    throw new SecurityEventTokenError('invalid_request', 'The token has no events.');
  }
  return { jti, iat, aud, events: parseRiscEvents(events) };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function cleanString(value: unknown, max = 320): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : undefined;
}

function parseSubject(raw: any): RiscSubject {
  if (!raw || typeof raw !== 'object') return {};
  const kind = raw.subject_type;
  if (kind === 'oauth_token') {
    if (raw.token_type && raw.token_type !== 'refresh_token') return {};
    const token = cleanString(raw.token, 2048);
    if (!token) return {};
    if (raw.token_identifier_alg === 'prefix') return { tokenPrefixHash: refreshTokenPrefixHash(token) };
    if (raw.token_identifier_alg === 'hash_base64_sha512_sha512') {
      return { tokenDoubleHash: normalizeBase64(token) };
    }
    return {};
  }
  // An `iss-sub` subject of another issuer names no Google account.
  if (raw.iss !== undefined && normalizeIssuer(raw.iss) !== GOOGLE_RISC_ISSUER) return {};
  const subject: RiscSubject = {};
  const sub = cleanString(raw.sub, 255);
  const email = cleanString(raw.email)?.toLowerCase();
  if (sub) subject.sub = sub;
  if (email) subject.email = email;
  return subject;
}

/** The action for one event. The policy is in docs/google-risc.md. */
export function riscActionFor(name: RiscEventName, reason?: string): RiscAction {
  switch (name) {
    case 'tokens-revoked':
    case 'token-revoked':
      return 'revoke';
    case 'account-disabled':
      // Hijacking (or no reason): Google locked the account to protect it.
      // A bulk-account reason asks only for a review of the activity.
      return !reason || reason === 'hijacking' ? 'hold' : 'log';
    case 'account-enabled':
      return 'release';
    case 'credential-change-required':
      return 'reconnect';
    default:
      return 'log';
  }
}

export function parseRiscEvents(events: Record<string, any>): RiscEvent[] {
  return Object.entries(events)
    .slice(0, 10)
    .map(([type, detail]) => {
      const name = EVENT_NAMES.get(type) ?? 'unknown';
      const reason = cleanString(detail?.reason, 64);
      const state = cleanString(detail?.state, 200);
      return {
        type,
        name,
        action: riscActionFor(name, reason),
        ...(reason ? { reason } : {}),
        ...(state ? { state } : {}),
        subject: parseSubject(detail?.subject),
      };
    });
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export interface RiscRecordResult {
  duplicate: boolean;
  matchedMail: number;
  matchedDrive: number;
  applied: number;
  forgetGrantIds: string[];
}

export type RiscDeliveryResult =
  | { status: 202; jti: string; duplicate: boolean; applied: boolean }
  | { status: 400; err: RiscErrorCode; description: string }
  | { status: 503; err: 'temporarily_unavailable'; description: string };

const ACCEPTED_TYPES = ['application/secevent+jwt', 'application/jwt', 'text/plain'];

/**
 * Handles one push delivery: verify, record (and apply with the flag on),
 * answer. The answer is 202 for a valid token, also for a duplicate `jti`.
 */
export async function handleRiscDelivery(input: {
  body: string;
  contentType?: string | null;
}): Promise<RiscDeliveryResult> {
  const type = String(input.contentType || '')
    .split(';')[0]!
    .trim()
    .toLowerCase();
  if (type && !ACCEPTED_TYPES.includes(type)) {
    return {
      status: 400,
      err: 'invalid_request',
      description: 'Send the token as application/secevent+jwt.',
    };
  }
  let verified: VerifiedSecurityEventToken;
  try {
    verified = await verifySecurityEventToken(input.body);
  } catch (err) {
    if (err instanceof SecurityEventTokenError) {
      console.warn('[google-risc] refused a token', err.code, err.message);
      return { status: 400, err: err.code, description: err.message };
    }
    console.error('[google-risc] could not verify a token', (err as Error)?.message || err);
    return { status: 503, err: 'temporarily_unavailable', description: 'Try again later.' };
  }
  const apply = isRiscProcessingEnabled();
  let result: RiscRecordResult;
  try {
    result = await deps.mutate<RiscRecordResult>(api.googleSecurity.recordSecurityEvent, {
      jti: verified.jti,
      issuedAt: verified.iat * 1000,
      apply,
      events: verified.events.map((event) => ({
        type: event.type,
        name: event.name,
        action: event.action,
        ...(event.reason ? { reason: event.reason } : {}),
        subject: event.subject,
      })),
    });
  } catch (err: any) {
    // Google sends the event again after an error answer.
    console.error('[google-risc] could not record an event', err?.message || err);
    return { status: 503, err: 'temporarily_unavailable', description: 'Try again later.' };
  }
  for (const grantId of result.forgetGrantIds || []) deps.forgetGoogleAccessToken(grantId);
  // No subject data in the log: the jti, the event names, and the counts.
  console.info('[google-risc] event', {
    jti: verified.jti,
    events: verified.events.map((event) =>
      event.name === 'verification' && event.state ? `verification state=${event.state}` : event.name,
    ),
    mode: apply ? 'applied' : 'logged',
    duplicate: result.duplicate,
    matchedMail: result.matchedMail,
    matchedDrive: result.matchedDrive,
    applied: result.applied,
  });
  return { status: 202, jti: verified.jti, duplicate: result.duplicate, applied: apply };
}
