import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { NextRequest } from 'next/server';
import { createRiscReceiver } from '../app/api/google/risc/route';
import {
  __setRiscDepsForTest,
  handleRiscDelivery,
  isRiscProcessingEnabled,
  normalizeIssuer,
  parseRiscEvents,
  RISC_CONFIGURATION_URL,
  RISC_EVENT_TYPES,
  RISC_MAX_TOKEN_AGE_MS,
  RiscUnavailableError,
  riscActionFor,
  riscAudiences,
  SecurityEventTokenError,
  verifySecurityEventToken,
} from '../lib/google/risc';
import { normalizeBase64, refreshTokenIdentifiers } from '../lib/google/token-identifiers';
import { isPublicRoute, shouldRequireBasicAuth } from '../proxy';

const NOW = 1_800_000_000_000;
const AUD = '452431903621-mail.apps.googleusercontent.com';
const DRIVE_AUD = '452431903621-drive.apps.googleusercontent.com';
const JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';
const SUB = '110248495921238986420';

const google = generateKeyPairSync('rsa', { modulusLength: 2048 });
const attacker = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = (key: KeyObject, kid: string) => ({
  ...key.export({ format: 'jwk' }),
  kid,
  alg: 'RS256',
  use: 'sig',
});

function segment(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function token(
  payload: unknown,
  options: { kid?: string | null; alg?: string; key?: KeyObject; header?: Record<string, unknown> } = {},
) {
  const header = segment({
    alg: options.alg ?? 'RS256',
    ...(options.kid === null ? {} : { kid: options.kid ?? 'key-1' }),
    typ: 'secevent+jwt',
    ...options.header,
  });
  const body = segment(payload);
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${body}`), options.key ?? google.privateKey);
  return `${header}.${body}.${signature.toString('base64url')}`;
}

function claims(overrides: Record<string, unknown> = {}) {
  return {
    iss: 'https://accounts.google.com/',
    aud: AUD,
    iat: NOW / 1000 - 60,
    jti: 'jti-1',
    events: {
      [RISC_EVENT_TYPES['tokens-revoked']]: {
        subject: { subject_type: 'iss-sub', iss: 'https://accounts.google.com/', sub: SUB },
      },
    },
    ...overrides,
  };
}

interface Setup {
  config?: unknown;
  configStatus?: number;
  keys?: () => unknown[];
  keysThrow?: boolean;
  env?: Record<string, string | undefined>;
  record?: (args: any) => any;
}

function setup(options: Setup = {}) {
  const state = {
    now: NOW,
    fetches: [] as string[],
    recorded: [] as any[],
    forgotten: [] as string[],
  };
  __setRiscDepsForTest({
    fetch: (async (url: string) => {
      state.fetches.push(url);
      if (url === RISC_CONFIGURATION_URL) {
        if (options.configStatus) return new Response('down', { status: options.configStatus });
        return Response.json(options.config ?? { issuer: 'https://accounts.google.com', jwks_uri: JWKS_URI });
      }
      if (options.keysThrow) throw Object.assign(new Error('socket hang up'), { name: 'TypeError' });
      return Response.json(
        { keys: options.keys ? options.keys() : [jwk(google.publicKey, 'key-1')] },
        { headers: { 'cache-control': 'public, max-age=21600, must-revalidate' } },
      );
    }) as any,
    now: () => state.now,
    env: () => options.env ?? { GOOGLE_MAIL_CLIENT_ID: AUD, GOOGLE_DRIVE_CLIENT_ID: DRIVE_AUD },
    mutate: (async (fn: unknown, args: any) => {
      expect(getFunctionName(fn as any)).toBe('googleSecurity:recordSecurityEvent');
      state.recorded.push(args);
      if (options.record) return options.record(args);
      return { duplicate: false, matchedMail: 1, matchedDrive: 0, applied: 0, forgetGrantIds: [] };
    }) as any,
    forgetGoogleAccessToken: (grantId: string) => state.forgotten.push(grantId),
  });
  return state;
}

afterEach(() => __setRiscDepsForTest());

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a refusal');
}

describe('verifySecurityEventToken', () => {
  test('accepts a token that Google signed for one of our client ids, and caches the keys', async () => {
    const state = setup();
    const verified = await verifySecurityEventToken(token(claims()));
    expect(verified).toMatchObject({ jti: 'jti-1', aud: [AUD], iat: NOW / 1000 - 60 });
    expect(verified.events).toEqual([
      {
        type: RISC_EVENT_TYPES['tokens-revoked'],
        name: 'tokens-revoked',
        action: 'revoke',
        subject: { sub: SUB },
      },
    ]);
    await verifySecurityEventToken(token(claims({ jti: 'jti-2', aud: [DRIVE_AUD, 'other'] })));
    // One configuration read and one key read for both tokens.
    expect(state.fetches).toEqual([RISC_CONFIGURATION_URL, JWKS_URI]);
  });

  test('accepts the issuer with or without the trailing slash', async () => {
    setup();
    await verifySecurityEventToken(token(claims({ iss: 'https://accounts.google.com' })));
    expect(normalizeIssuer('https://accounts.google.com///')).toBe('https://accounts.google.com');
    expect(normalizeIssuer(42)).toBe('');
  });

  test('refuses a token signed with another key', async () => {
    setup();
    const error = await refusal(verifySecurityEventToken(token(claims(), { key: attacker.privateKey })));
    expect(error).toBeInstanceOf(SecurityEventTokenError);
    expect((error as SecurityEventTokenError).code).toBe('authentication_failed');
  });

  test('an unknown key id reloads the key set at most once a minute, so a key rotation works', async () => {
    let rotated = false;
    const state = setup({
      keys: () =>
        rotated
          ? [jwk(google.publicKey, 'key-1'), jwk(attacker.publicKey, 'key-2')]
          : [jwk(google.publicKey, 'key-1')],
    });
    await verifySecurityEventToken(token(claims()));
    const unknown = token(claims(), { kid: 'key-2', key: attacker.privateKey });
    rotated = true;
    // Loaded just now: no second load within a minute.
    expect(((await refusal(verifySecurityEventToken(unknown))) as SecurityEventTokenError).code).toBe(
      'invalid_key',
    );
    expect(state.fetches.filter((url) => url === JWKS_URI)).toHaveLength(1);
    state.now += 61_000;
    await verifySecurityEventToken(unknown);
    expect(state.fetches.filter((url) => url === JWKS_URI)).toHaveLength(2);
  });

  test('skips keys that are not RS256 signing keys', async () => {
    setup({
      keys: () => [
        { ...jwk(google.publicKey, 'key-1'), alg: 'RS512' },
        { ...jwk(google.publicKey, 'key-1'), use: 'enc' },
        { kty: 'EC', kid: 'key-1' },
        { kty: 'RSA', kid: 'key-1', e: 'AQAB' },
        { kty: 'RSA', n: 'AQAB', e: 'AQAB' },
        null,
      ],
    });
    const error = await refusal(verifySecurityEventToken(token(claims())));
    expect((error as SecurityEventTokenError).code).toBe('invalid_key');
  });

  test('refuses another issuer', async () => {
    setup();
    const error = await refusal(verifySecurityEventToken(token(claims({ iss: 'https://evil.example/' }))));
    expect((error as SecurityEventTokenError).code).toBe('invalid_issuer');
  });

  test('refuses another audience, and every token when no client id is configured', async () => {
    setup();
    const other = await refusal(verifySecurityEventToken(token(claims({ aud: 'someone-else' }))));
    expect((other as SecurityEventTokenError).code).toBe('invalid_audience');
    const missing = await refusal(verifySecurityEventToken(token(claims({ aud: 42 }))));
    expect((missing as SecurityEventTokenError).code).toBe('invalid_audience');
    setup({ env: {} });
    const none = await refusal(verifySecurityEventToken(token(claims())));
    expect((none as SecurityEventTokenError).code).toBe('invalid_audience');
  });

  test('refuses a token that is too old, from the future, or without an issue time', async () => {
    setup();
    for (const iat of [
      (NOW - RISC_MAX_TOKEN_AGE_MS) / 1000 - 1,
      NOW / 1000 + 10 * 60,
      'yesterday',
      undefined,
    ]) {
      const error = await refusal(verifySecurityEventToken(token(claims({ iat }))));
      expect((error as SecurityEventTokenError).code).toBe('invalid_request');
    }
    // Clock skew of a few minutes is fine.
    await verifySecurityEventToken(token(claims({ iat: NOW / 1000 + 120 })));
  });

  test('refuses malformed tokens before it reads any key', async () => {
    const state = setup();
    const good = token(claims());
    const [header, payload, signature] = good.split('.');
    const cases: Array<[string, string]> = [
      ['', 'invalid_request'],
      ['x'.repeat(20_000), 'invalid_request'],
      ['only.two', 'invalid_request'],
      [`${header}..${signature}`, 'invalid_request'],
      [`${header}.${payload}.sig+nature`, 'invalid_request'],
      [`not*base64.${payload}.${signature}`, 'invalid_request'],
      [`${Buffer.from('not json').toString('base64url')}.${payload}.${signature}`, 'invalid_request'],
      [token(claims(), { alg: 'none' }), 'invalid_request'],
      [token(claims(), { alg: 'HS256' }), 'invalid_request'],
      [token(claims(), { kid: null }), 'invalid_key'],
      [token([1, 2, 3]), 'invalid_request'],
    ];
    for (const [value, code] of cases) {
      const error = await refusal(verifySecurityEventToken(value));
      expect([value.slice(0, 20), (error as SecurityEventTokenError).code]).toEqual([
        value.slice(0, 20),
        code,
      ]);
    }
    expect(state.fetches).toEqual([]);
  });

  test('refuses a signed token without a jti or events', async () => {
    setup();
    for (const overrides of [{ jti: '' }, { jti: 'x'.repeat(300) }, { events: {} }, { events: [] }]) {
      const error = await refusal(verifySecurityEventToken(token(claims(overrides))));
      expect((error as SecurityEventTokenError).code).toBe('invalid_request');
    }
  });

  test('fails closed when the Google configuration cannot be read or is not Google', async () => {
    setup({ configStatus: 500 });
    expect(await refusal(verifySecurityEventToken(token(claims())))).toBeInstanceOf(RiscUnavailableError);
    setup({ config: { issuer: 'https://evil.example', jwks_uri: JWKS_URI } });
    expect(await refusal(verifySecurityEventToken(token(claims())))).toBeInstanceOf(RiscUnavailableError);
    setup({ config: { issuer: 'https://accounts.google.com', jwks_uri: 'http://plain.example/keys' } });
    expect(await refusal(verifySecurityEventToken(token(claims())))).toBeInstanceOf(RiscUnavailableError);
    setup({ keysThrow: true });
    expect(await refusal(verifySecurityEventToken(token(claims())))).toBeInstanceOf(RiscUnavailableError);
  });
});

describe('configuration', () => {
  test('the audiences come from LAB86_GOOGLE_RISC_AUDIENCES, else from the Google client ids', () => {
    expect(
      riscAudiences({ LAB86_GOOGLE_RISC_AUDIENCES: ' a , b,,a ', GOOGLE_MAIL_CLIENT_ID: 'mail' }),
    ).toEqual(['a', 'b']);
    expect(riscAudiences({ GOOGLE_MAIL_CLIENT_ID: ' mail ', GOOGLE_DRIVE_CLIENT_ID: 'mail' })).toEqual([
      'mail',
    ]);
    expect(riscAudiences({ GOOGLE_DRIVE_CLIENT_ID: 'drive' })).toEqual(['drive']);
    expect(riscAudiences({})).toEqual([]);
  });

  test('event processing is on only when LAB86_GOOGLE_RISC is exactly 1', () => {
    expect(isRiscProcessingEnabled({})).toBe(false);
    expect(isRiscProcessingEnabled({ LAB86_GOOGLE_RISC: 'true' })).toBe(false);
    expect(isRiscProcessingEnabled({ LAB86_GOOGLE_RISC: '1' })).toBe(true);
  });
});

describe('events', () => {
  const issSub = { subject_type: 'iss-sub', iss: 'https://accounts.google.com/', sub: SUB };

  test('each event type gets its action', () => {
    const events = parseRiscEvents({
      [RISC_EVENT_TYPES['sessions-revoked']]: { subject: issSub },
      [RISC_EVENT_TYPES['tokens-revoked']]: { subject: issSub },
      [RISC_EVENT_TYPES['account-disabled']]: { subject: issSub, reason: 'hijacking' },
      [RISC_EVENT_TYPES['account-enabled']]: { subject: issSub },
      [RISC_EVENT_TYPES['credential-change-required']]: { subject: issSub },
      [RISC_EVENT_TYPES.verification]: { state: 'run 1' },
      'https://schemas.openid.net/secevent/risc/event-type/account-purged': { subject: issSub },
      'https://example.com/other': {},
    });
    expect(events.map((event) => [event.name, event.action])).toEqual([
      ['sessions-revoked', 'log'],
      ['tokens-revoked', 'revoke'],
      ['account-disabled', 'hold'],
      ['account-enabled', 'release'],
      ['credential-change-required', 'reconnect'],
      ['verification', 'log'],
      ['account-purged', 'log'],
      ['unknown', 'log'],
    ]);
    expect(events[2]?.reason).toBe('hijacking');
    expect(events[5]).toMatchObject({ state: 'run 1', subject: {} });
  });

  test('account-disabled holds for hijacking or no reason, and only logs bulk-account', () => {
    expect(riscActionFor('account-disabled', 'hijacking')).toBe('hold');
    expect(riscActionFor('account-disabled')).toBe('hold');
    expect(riscActionFor('account-disabled', 'bulk-account')).toBe('log');
    expect(riscActionFor('token-revoked')).toBe('revoke');
  });

  test('a subject gives a Google account id, an email, or a refresh token identifier', () => {
    const refresh = '1//0gAbCdEfGhIjKlMnOpQrStUvWxYz-0123456789';
    const ids = refreshTokenIdentifiers(refresh);
    // Google's form: base64 of SHA-512 of SHA-512 of the token, with padding.
    const googleHash = createHash('sha512')
      .update(createHash('sha512').update(refresh).digest())
      .digest('base64');
    const subjects = parseRiscEvents({
      a: { subject: { subject_type: 'id_token_claims', sub: SUB, email: ' Ann@Example.com ' } },
      b: { subject: { subject_type: 'email', email: 'bo@example.com' } },
      c: { subject: { subject_type: 'iss-sub', iss: 'https://other.example/', sub: SUB } },
      d: {
        subject: {
          subject_type: 'oauth_token',
          token_type: 'refresh_token',
          token_identifier_alg: 'prefix',
          token: refresh.slice(0, 16),
        },
      },
      e: {
        subject: {
          subject_type: 'oauth_token',
          token_type: 'refresh_token',
          token_identifier_alg: 'hash_base64_sha512_sha512',
          token: googleHash,
        },
      },
      f: { subject: { subject_type: 'oauth_token', token_type: 'access_token', token: 'x' } },
      g: { subject: { subject_type: 'oauth_token', token_identifier_alg: 'plain', token: refresh } },
      h: { subject: { subject_type: 'oauth_token', token_identifier_alg: 'prefix' } },
      i: {},
      j: { subject: 'not an object' },
    }).map((event) => event.subject);
    expect(subjects).toEqual([
      { sub: SUB, email: 'ann@example.com' },
      { email: 'bo@example.com' },
      {},
      { tokenPrefixHash: ids.refreshTokenPrefixHash },
      { tokenDoubleHash: ids.refreshTokenDoubleHash },
      {},
      {},
      {},
      {},
      {},
    ]);
    // A base64url or padded hash compares equal.
    expect(normalizeBase64(googleHash.replace(/\+/g, '-').replace(/\//g, '_'))).toBe(
      ids.refreshTokenDoubleHash as string,
    );
    expect(refreshTokenIdentifiers('')).toEqual({});
    expect(refreshTokenIdentifiers(undefined)).toEqual({});
  });
});

describe('handleRiscDelivery', () => {
  test('with the flag off it verifies, records, and answers 202 with no changes', async () => {
    const state = setup();
    const result = await handleRiscDelivery({
      body: token(claims()),
      contentType: 'application/secevent+jwt; charset=utf-8',
    });
    expect(result).toEqual({ status: 202, jti: 'jti-1', duplicate: false, applied: false });
    expect(state.recorded).toEqual([
      {
        jti: 'jti-1',
        issuedAt: NOW - 60_000,
        apply: false,
        events: [
          {
            type: RISC_EVENT_TYPES['tokens-revoked'],
            name: 'tokens-revoked',
            action: 'revoke',
            subject: { sub: SUB },
          },
        ],
      },
    ]);
  });

  test('with LAB86_GOOGLE_RISC=1 it applies, and forgets the cached tokens of changed grants', async () => {
    const state = setup({
      env: { GOOGLE_MAIL_CLIENT_ID: AUD, LAB86_GOOGLE_RISC: '1' },
      record: () => ({
        duplicate: false,
        matchedMail: 1,
        matchedDrive: 1,
        applied: 2,
        forgetGrantIds: ['google:abc'],
      }),
    });
    const verification = token(
      claims({
        jti: 'jti-v',
        events: {
          [RISC_EVENT_TYPES['account-disabled']]: { subject: { subject_type: 'iss-sub', sub: SUB } },
          [RISC_EVENT_TYPES.verification]: { state: 'hello' },
        },
      }),
    );
    const result = await handleRiscDelivery({ body: verification, contentType: null });
    expect(result).toMatchObject({ status: 202, applied: true });
    expect(state.recorded[0]).toMatchObject({ apply: true });
    expect(state.recorded[0].events[0]).toEqual({
      type: RISC_EVENT_TYPES['account-disabled'],
      name: 'account-disabled',
      action: 'hold',
      subject: { sub: SUB },
    });
    expect(state.forgotten).toEqual(['google:abc']);
  });

  test('a second delivery of the same jti is accepted again', async () => {
    setup({
      record: () => ({ duplicate: true, matchedMail: 0, matchedDrive: 0, applied: 0, forgetGrantIds: [] }),
    });
    expect(await handleRiscDelivery({ body: token(claims()), contentType: 'application/jwt' })).toMatchObject(
      {
        status: 202,
        duplicate: true,
      },
    );
  });

  test('a bad token or content type is a 400 with an RFC 8935 error code', async () => {
    const state = setup();
    expect(await handleRiscDelivery({ body: token(claims()), contentType: 'application/json' })).toEqual({
      status: 400,
      err: 'invalid_request',
      description: 'Send the token as application/secevent+jwt.',
    });
    expect(
      await handleRiscDelivery({
        body: token(claims(), { key: attacker.privateKey }),
        contentType: 'text/plain',
      }),
    ).toMatchObject({ status: 400, err: 'authentication_failed' });
    expect(state.recorded).toEqual([]);
  });

  test('Google keys or Convex out of reach is a 503, so Google sends the event again', async () => {
    setup({ configStatus: 503 });
    expect(await handleRiscDelivery({ body: token(claims()) })).toMatchObject({
      status: 503,
      err: 'temporarily_unavailable',
    });
    setup({
      record: () => {
        throw new Error('convex down');
      },
    });
    expect(await handleRiscDelivery({ body: token(claims()) })).toMatchObject({ status: 503 });
  });
});

describe('the RISC route', () => {
  test('answers 202 with no body, or 400 with the error', async () => {
    const handle = async ({ body }: { body: string }) =>
      body === 'good'
        ? ({ status: 202, jti: 'j', duplicate: false, applied: false } as const)
        : ({ status: 400, err: 'invalid_request', description: 'bad' } as const);
    const route = createRiscReceiver(handle as any);
    const post = (body: string, headers: Record<string, string> = {}) =>
      route(
        new NextRequest('https://mail.lab86.io/api/google/risc', {
          method: 'POST',
          body,
          headers: { 'content-type': 'application/secevent+jwt', ...headers },
        }),
      );
    const accepted = await post('good');
    expect(accepted.status).toBe(202);
    expect(await accepted.text()).toBe('');
    const refused = await post('bad');
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ err: 'invalid_request', description: 'bad' });
    const large = await post('x'.repeat(20_000));
    expect(large.status).toBe(400);
    const declared = await post('good', { 'content-length': '999999' });
    expect(declared.status).toBe(400);
  });

  test('the default route verifies a real token end to end', async () => {
    setup();
    const response = await createRiscReceiver()(
      new NextRequest('https://mail.lab86.io/api/google/risc', {
        method: 'POST',
        body: token(claims()),
        headers: { 'content-type': 'application/secevent+jwt' },
      }),
    );
    expect(response.status).toBe(202);
  });

  test('Google reaches the route without a Clerk session or basic auth', () => {
    expect(isPublicRoute(new NextRequest('https://mail.lab86.io/api/google/risc'))).toBe(true);
    const previous = process.env.LAB86_MAIL_REQUIRE_BASIC_AUTH;
    process.env.LAB86_MAIL_REQUIRE_BASIC_AUTH = '1';
    try {
      const request = new Request('https://mail.lab86.io/api/google/risc', { method: 'POST' });
      expect(shouldRequireBasicAuth(request, '/api/google/risc')).toBe(false);
      expect(shouldRequireBasicAuth(request, '/api/google/other')).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.LAB86_MAIL_REQUIRE_BASIC_AUTH;
      else process.env.LAB86_MAIL_REQUIRE_BASIC_AUTH = previous;
    }
  });
});
