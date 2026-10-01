import { beforeEach, describe, expect, test } from 'bun:test';
import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import {
  bearerToken,
  createPubSubPushVerifier,
  GOOGLE_OIDC_CERTS_URL,
  OIDC_CLOCK_SKEW_MS,
} from '../lib/google/push/oidc';

const NOW = 1_800_000_000_000;
const AUDIENCE = 'https://mail.lab86.io/api/google/push/gmail';
const ACCOUNT = 'gmail-push-invoker@lab86-mail-production.iam.gserviceaccount.com';
const EXPECT = { audience: AUDIENCE, serviceAccount: ACCOUNT };

function rsaKey(): { privateKey: KeyObject; jwk: Record<string, unknown> } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { privateKey, jwk: publicKey.export({ format: 'jwk' }) as Record<string, unknown> };
}

const keyA = rsaKey();
const keyB = rsaKey();

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

function claims(overrides: Record<string, unknown> = {}) {
  return {
    iss: 'https://accounts.google.com',
    aud: AUDIENCE,
    azp: '1234567890',
    sub: '1234567890',
    email: ACCOUNT,
    email_verified: true,
    iat: Math.floor(NOW / 1000) - 10,
    exp: Math.floor(NOW / 1000) + 3600,
    ...overrides,
  };
}

function token(
  body: Record<string, unknown> = claims(),
  {
    kid = 'kid-a',
    alg = 'RS256',
    key = keyA.privateKey,
  }: { kid?: string; alg?: string; key?: KeyObject } = {},
) {
  const head = encode({ alg, kid, typ: 'JWT' });
  const payload = encode(body);
  const signature = sign('sha256', Buffer.from(`${head}.${payload}`), key).toString('base64url');
  return `${head}.${payload}.${signature}`;
}

let fetches: string[];
let published: Array<Record<string, unknown>>;
let certsStatus: number;
let now: number;

function verifier() {
  return createPubSubPushVerifier({
    now: () => now,
    fetch: async (url: string) => {
      fetches.push(url);
      return new Response(JSON.stringify({ keys: published }), {
        status: certsStatus,
        headers: { 'cache-control': 'public, max-age=3600' },
      });
    },
  });
}

beforeEach(() => {
  fetches = [];
  published = [{ ...keyA.jwk, kid: 'kid-a', alg: 'RS256', use: 'sig' }];
  certsStatus = 200;
  now = NOW;
});

describe('bearerToken', () => {
  test('reads a bearer token and nothing else', () => {
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(bearerToken('bearer   abc')).toBe('abc');
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken('Bearer a b')).toBeNull();
    expect(bearerToken(null)).toBeNull();
  });
});

describe('Pub/Sub push token', () => {
  test('a good token passes, and the keys load once', async () => {
    const verify = verifier();
    const first = await verify(token(), EXPECT);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.claims.email).toBe(ACCOUNT);
    expect(await verify(token(claims({ iss: 'accounts.google.com' })), EXPECT)).toMatchObject({ ok: true });
    expect(fetches).toEqual([GOOGLE_OIDC_CERTS_URL]);
  });

  test('the email check ignores case', async () => {
    const result = await verifier()(token(claims({ email: ACCOUNT.toUpperCase() })), EXPECT);
    expect(result.ok).toBe(true);
  });

  test('a wrong issuer, audience, or service account fails', async () => {
    const verify = verifier();
    expect(await verify(token(claims({ iss: 'https://evil.example' })), EXPECT)).toEqual({
      ok: false,
      reason: 'issuer',
    });
    expect(await verify(token(claims({ aud: 'https://mail.lab86.io/other' })), EXPECT)).toEqual({
      ok: false,
      reason: 'audience',
    });
    expect(await verify(token(claims({ aud: [AUDIENCE] })), EXPECT)).toEqual({
      ok: false,
      reason: 'audience',
    });
    expect(await verify(token(claims({ email: 'someone@example.com' })), EXPECT)).toEqual({
      ok: false,
      reason: 'email',
    });
    expect(await verify(token(claims({ email_verified: false })), EXPECT)).toEqual({
      ok: false,
      reason: 'email',
    });
    expect(await verify(token(claims({ email_verified: 'true' })), EXPECT)).toEqual({
      ok: false,
      reason: 'email',
    });
  });

  test('an expired token fails; a token inside the clock skew passes', async () => {
    const verify = verifier();
    const expired = claims({ exp: Math.floor((NOW - OIDC_CLOCK_SKEW_MS) / 1000) - 1 });
    expect(await verify(token(expired), EXPECT)).toEqual({ ok: false, reason: 'expired' });
    const skewed = claims({ exp: Math.floor(NOW / 1000) - 30 });
    expect((await verify(token(skewed), EXPECT)).ok).toBe(true);
    expect(await verify(token(claims({ exp: 'soon' })), EXPECT)).toEqual({ ok: false, reason: 'expired' });
  });

  test('a token issued in the future fails', async () => {
    const future = claims({ iat: Math.floor((NOW + 2 * OIDC_CLOCK_SKEW_MS) / 1000) });
    expect(await verifier()(token(future), EXPECT)).toEqual({ ok: false, reason: 'not_yet_valid' });
    expect(await verifier()(token(claims({ iat: undefined })), EXPECT)).toEqual({
      ok: false,
      reason: 'not_yet_valid',
    });
  });

  test('a token signed by another key fails', async () => {
    const forged = token(claims(), { key: keyB.privateKey });
    expect(await verifier()(forged, EXPECT)).toEqual({ ok: false, reason: 'signature' });
    const [head, payload] = token().split('.');
    expect(await verifier()(`${head}.${payload}.AAAA`, EXPECT)).toEqual({ ok: false, reason: 'signature' });
  });

  test('a changed payload fails the signature', async () => {
    const [head, , signature] = token().split('.');
    const payload = encode(claims({ email: 'attacker@example.com' }));
    expect(await verifier()(`${head}.${payload}.${signature}`, EXPECT)).toEqual({
      ok: false,
      reason: 'signature',
    });
  });

  test('a missing, malformed, or non-RS256 token fails', async () => {
    const verify = verifier();
    expect(await verify(null, EXPECT)).toEqual({ ok: false, reason: 'missing' });
    expect(await verify('abc', EXPECT)).toEqual({ ok: false, reason: 'malformed' });
    expect(await verify('a..c', EXPECT)).toEqual({ ok: false, reason: 'malformed' });
    expect(await verify('###.###.###', EXPECT)).toEqual({ ok: false, reason: 'malformed' });
    expect(await verify(`${encode('x')}.${encode('y')}.sig`, EXPECT)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(await verify(`x.${'a'.repeat(9000)}.y`, EXPECT)).toEqual({ ok: false, reason: 'malformed' });
    expect(await verify(token(claims(), { alg: 'HS256' }), EXPECT)).toEqual({
      ok: false,
      reason: 'algorithm',
    });
    expect(await verify(token(claims(), { alg: 'none' }), EXPECT)).toEqual({
      ok: false,
      reason: 'algorithm',
    });
    expect(fetches).toEqual([]);
  });

  test('an unknown key id fetches the keys again, at most once a minute', async () => {
    const verify = verifier();
    expect((await verify(token(), EXPECT)).ok).toBe(true);
    // Google rotates its keys: kid-b is new.
    published = [
      { ...keyA.jwk, kid: 'kid-a' },
      { ...keyB.jwk, kid: 'kid-b' },
    ];
    now += 120_000;
    expect((await verify(token(claims(), { kid: 'kid-b', key: keyB.privateKey }), EXPECT)).ok).toBe(true);
    expect(fetches).toHaveLength(2);
    // A key id that Google does not publish fails without a new fetch in the same minute.
    expect(await verify(token(claims(), { kid: 'kid-x' }), EXPECT)).toEqual({
      ok: false,
      reason: 'unknown_key',
    });
    expect(fetches).toHaveLength(2);
  });

  test('the keys load again after their cache time', async () => {
    const verify = verifier();
    expect((await verify(token(), EXPECT)).ok).toBe(true);
    now += 3_600_000;
    expect(
      (await verify(token(claims({ iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 60 })), EXPECT))
        .ok,
    ).toBe(true);
    expect(fetches).toHaveLength(2);
  });

  test('keys that cannot load fail closed', async () => {
    certsStatus = 503;
    expect(await verifier()(token(), EXPECT)).toEqual({ ok: false, reason: 'keys_unavailable' });
    certsStatus = 200;
    published = [{ kty: 'EC', kid: 'kid-a' }];
    expect(await verifier()(token(), EXPECT)).toEqual({ ok: false, reason: 'keys_unavailable' });
  });

  test('a key that does not parse is skipped', async () => {
    published = [
      { kty: 'RSA', kid: 'broken', n: '!!', e: '!!' },
      { ...keyA.jwk, kid: 'kid-a' },
    ];
    expect((await verifier()(token(), EXPECT)).ok).toBe(true);
  });

  test('a response without a max-age keeps the keys for one hour', async () => {
    const calls: string[] = [];
    const verify = createPubSubPushVerifier({
      now: () => now,
      fetch: async (url: string) => {
        calls.push(url);
        return new Response(JSON.stringify({ keys: published }), { status: 200 });
      },
    });
    expect((await verify(token(), EXPECT)).ok).toBe(true);
    now += 59 * 60_000;
    expect((await verify(token(claims({ iat: Math.floor(now / 1000) })), EXPECT)).ok).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
