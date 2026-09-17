import { afterEach, describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import {
  createNativeWebSessionDelete,
  createNativeWebSessionPatch,
  createNativeWebSessionPost,
} from '../app/api/native/web-session/route';
import { AuthRequiredError } from '../lib/auth/current-user';
import {
  createNativeBrowserAccess,
  NATIVE_BROWSER_TTL_SECONDS,
  verifyNativeBrowserAccess,
} from '../lib/native/browser-access';
import { nativeBrowserDestination } from '../lib/native/browser-destination';
import { completeNativeBrowserSignIn } from '../lib/native/browser-session';
import { RateLimitError } from '../lib/rate-limit';

const original = process.env.RAILWAY_ENVIRONMENT_NAME;
afterEach(() => {
  if (original === undefined) delete process.env.RAILWAY_ENVIRONMENT_NAME;
  else process.env.RAILWAY_ENVIRONMENT_NAME = original;
});

function request(method = 'POST', body: unknown = {}, authorization: string | null = 'Bearer native-token') {
  return new NextRequest('https://mail.lab86.io/api/native/web-session', {
    method,
    headers: { 'Content-Type': 'application/json', ...(authorization ? { authorization } : {}) },
    body: JSON.stringify(body),
  });
}
function harness() {
  process.env.RAILWAY_ENVIRONMENT_NAME = 'production';
  const issue = mock(async (_input: unknown) => ({ token: 'single-use-ticket' }));
  const revoke = mock(async (_id: string) => ({}));
  const getSession = mock(async (id: string) => ({ id, userId: 'owner', status: 'active' }));
  const rate = mock(async (_input: unknown) => ({}));
  const deps = {
    requireCurrentUser: async () => ({ userId: 'owner' }),
    auth: async () => ({ sessionId: 'sess_native' }),
    clerkClient: async () => ({
      signInTokens: { createSignInToken: issue },
      sessions: { getSession, revokeSession: revoke },
    }),
    enforceUserRateLimit: rate,
    createAccess: mock(async () => ({ value: 'signed-access', expiresAt: 2_000_000_000 })),
  };
  return { deps: deps as any, issue, revoke, getSession, rate };
}

describe('native editor sessions', () => {
  test('only the authenticated user receives a one-minute, noncacheable ticket', async () => {
    const h = harness();
    const response = await createNativeWebSessionPost(h.deps)(
      request('POST', { userId: 'victim', expiresInSeconds: 999999 }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(await response.json()).toEqual({
      ok: true,
      ticket: 'single-use-ticket',
      userId: 'owner',
      access: null,
    });
    expect(h.issue).toHaveBeenCalledWith({ userId: 'owner', expiresInSeconds: 60 });
    expect(h.rate).toHaveBeenCalledWith({
      userId: 'owner',
      key: 'native-web-session',
      limit: 20,
      windowMs: 60000,
    });
  });
  test('cookie-only callers and invalid sessions cannot mint tickets', async () => {
    const h = harness();
    for (const header of [null, 'Basic abc', 'Bearer']) {
      expect((await createNativeWebSessionPost(h.deps)(request('POST', {}, header))).status).toBe(401);
    }
    h.deps.requireCurrentUser = async () => {
      throw new AuthRequiredError('invalid');
    };
    expect((await createNativeWebSessionPost(h.deps)(request())).status).toBe(401);
    expect(h.issue).not.toHaveBeenCalled();
  });
  test('rate limits and configuration failures fail closed without minting credentials', async () => {
    const h = harness();
    h.deps.enforceUserRateLimit = async () => {
      throw new RateLimitError('wait', 1000, 20);
    };
    expect((await createNativeWebSessionPost(h.deps)(request())).status).toBe(429);
    expect(h.issue).not.toHaveBeenCalled();
    process.env.RAILWAY_ENVIRONMENT_NAME = 'development';
    h.deps.enforceUserRateLimit = async () => ({});
    h.deps.createAccess = async () => {
      throw new Error('secret must not leak');
    };
    const response = await createNativeWebSessionPost(h.deps)(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('secret must not leak');
    expect(h.issue).not.toHaveBeenCalled();
  });
  test('staging receives a signed browser capability rather than the Basic password', async () => {
    const h = harness();
    process.env.RAILWAY_ENVIRONMENT_NAME = 'development';
    const response = await createNativeWebSessionPost(h.deps)(request());
    expect((await response.json()).access).toEqual({ value: 'signed-access', expiresAt: 2000000000 });
  });
  test('renewing staging access never mints a ticket and still requires native authentication', async () => {
    const h = harness();
    process.env.RAILWAY_ENVIRONMENT_NAME = 'development';
    const renew = createNativeWebSessionPatch(h.deps);
    const response = await renew(request('PATCH'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(await response.json()).toEqual({
      ok: true,
      userId: 'owner',
      access: { value: 'signed-access', expiresAt: 2000000000 },
    });
    expect(h.issue).not.toHaveBeenCalled();
    expect((await renew(request('PATCH', {}, null))).status).toBe(401);
    process.env.RAILWAY_ENVIRONMENT_NAME = 'production';
    expect((await (await renew(request('PATCH'))).json()).access).toBeNull();
  });
  test('closing revokes only a separate session owned by the native caller', async () => {
    const h = harness();
    const close = createNativeWebSessionDelete(h.deps);
    expect((await close(request('DELETE', { sessionId: 'sess_browser' }))).status).toBe(200);
    expect(h.revoke).toHaveBeenCalledWith('sess_browser');
    for (const id of ['sess_native', '', '../session', null]) {
      expect((await close(request('DELETE', { sessionId: id }))).status).toBe(400);
    }
    h.getSession.mockImplementation(async (id) => ({ id, userId: 'another-user', status: 'active' }));
    expect((await close(request('DELETE', { sessionId: 'sess_other' }))).status).toBe(404);
    expect(h.revoke).toHaveBeenCalledTimes(1);
    expect((await close(request('DELETE', { sessionId: 'sess_browser' }, null))).status).toBe(401);
  });
  test('closing an already revoked browser session succeeds without another revocation', async () => {
    const h = harness();
    h.getSession.mockImplementation(async (id) => ({ id, userId: 'owner', status: 'revoked' }));
    expect(
      (await createNativeWebSessionDelete(h.deps)(request('DELETE', { sessionId: 'sess_browser' }))).status,
    ).toBe(200);
    expect(h.revoke).not.toHaveBeenCalled();
  });
});

describe('staging browser capability', () => {
  test('is bound to its origin, signing key, bounded expiry and complete payload', async () => {
    const now = 1_800_000_000_000;
    const access = await createNativeBrowserAccess('https://staging.test', 'secret', now);
    expect(access.expiresAt).toBe(now / 1000 + NATIVE_BROWSER_TTL_SECONDS);
    expect(await verifyNativeBrowserAccess(access.value, 'https://staging.test', 'secret', now)).toBe(true);
    for (const [origin, secret, time] of [
      ['https://other.test', 'secret', now],
      ['https://staging.test:8443', 'secret', now],
      ['https://staging.test', 'wrong', now],
      ['https://staging.test', 'secret', now + 3600000],
      ['https://staging.test', 'secret', now - 1000],
    ] as const)
      expect(await verifyNativeBrowserAccess(access.value, origin, secret, time)).toBe(false);
    for (const value of [
      undefined,
      '',
      'forged',
      `${access.value}x`,
      access.value.replace(/.$/u, access.value.endsWith('a') ? 'b' : 'a'),
    ]) {
      expect(await verifyNativeBrowserAccess(value, 'https://staging.test', 'secret', now)).toBe(false);
    }
    expect(await verifyNativeBrowserAccess(access.value, 'https://staging.test', undefined, now)).toBe(false);
    await expect(createNativeBrowserAccess('https://staging.test', '', now)).rejects.toThrow(
      'not configured',
    );
  });
});

test('native handoff accepts product routes and encoded IDs, never arbitrary redirects or API calls', () => {
  for (const path of [
    '/',
    '/settings',
    '/narrative',
    '/?view=calendar',
    '/native/files?document=a%26b',
    '/native/files?provider=google_drive&connection=c&file=f&mime=application%2Ftest',
  ]) {
    expect(nativeBrowserDestination(path)).toBe(path);
  }
  for (const path of [
    null,
    '//evil.test',
    '/\\evil.test',
    'https://evil.test',
    '/api/account',
    '/sign-in',
    '/?redirect=https://evil.test',
    '/settings#fragment',
    '/\nsettings',
    '/native/session',
  ]) {
    expect(nativeBrowserDestination(path)).toBeNull();
  }
});

describe('native browser bootstrap', () => {
  const input = { ticket: 'one-time-ticket', userId: 'owner', destination: '/native/files?document=one' };
  function actions() {
    return {
      signIn: mock(async (_ticket: string) => ({ status: 'complete', createdSessionId: 'sess_browser' })),
      reportSession: mock((_session: string) => {}),
      activate: mock(async (_session: string) => 'owner'),
    };
  }
  test('activates the separate session before returning a safe destination', async () => {
    const a = actions();
    a.activate.mockImplementation(async () => {
      expect(a.reportSession).toHaveBeenCalledWith('sess_browser');
      return 'owner';
    });
    expect(await completeNativeBrowserSignIn(input, a)).toBe(input.destination);
    expect(a.signIn).toHaveBeenCalledWith(input.ticket);
  });
  test('rejects invalid destinations before sign-in and blocks incomplete or mismatched accounts', async () => {
    const a = actions();
    await expect(completeNativeBrowserSignIn({ ...input, destination: '//evil.test' }, a)).rejects.toThrow();
    expect(a.signIn).not.toHaveBeenCalled();
    a.signIn.mockImplementation(async () => ({
      status: 'needs_second_factor',
      createdSessionId: 'sess_browser',
    }));
    await expect(completeNativeBrowserSignIn(input, a)).rejects.toThrow('not completed');
    expect(a.activate).not.toHaveBeenCalled();
    a.signIn.mockImplementation(async () => ({ status: 'complete', createdSessionId: 'sess_browser' }));
    a.activate.mockImplementation(async () => 'someone-else');
    await expect(completeNativeBrowserSignIn(input, a)).rejects.toThrow('mismatch');
    expect(a.reportSession).toHaveBeenCalledWith('sess_browser');
  });
  test('reports the session for cleanup even if activation fails', async () => {
    const a = actions();
    a.activate.mockImplementation(async () => {
      throw new Error('offline');
    });
    await expect(completeNativeBrowserSignIn(input, a)).rejects.toThrow('offline');
    expect(a.reportSession).toHaveBeenCalledWith('sess_browser');
  });
});
