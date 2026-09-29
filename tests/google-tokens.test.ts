import { afterEach, describe, expect, test } from 'bun:test';
import { GoogleApiError } from '../lib/google/errors';
import {
  buildGoogleMailAuthorizationUrl,
  exchangeGoogleAuthorizationCode,
  fetchGmailProfile,
  fetchGoogleUserInfo,
  GOOGLE_MAIL_SCOPES,
  googleOAuthClient,
  grantedScopes,
  pkcePair,
  refreshGoogleAccessToken,
  requireGoogleOAuthClient,
  revokeGoogleToken,
} from '../lib/google/oauth';
import {
  __setGoogleTokenDepsForTest,
  forgetGoogleAccessToken,
  getGoogleAccessToken,
  invalidateGoogleAccessToken,
} from '../lib/google/tokens';
import { isGrantGoneError } from '../lib/nylas/grant-health';

const GRANT = 'google:acct-1';
const NOW = 1_800_000_000_000;

afterEach(() => __setGoogleTokenDepsForTest());

function harness(stored: Record<string, unknown> | null, refresh?: (token: string) => Promise<any>) {
  const calls = {
    queries: 0,
    refreshes: [] as string[],
    saved: [] as any[],
    marked: [] as Array<{ grantId?: string; detail: string }>,
  };
  let now = NOW;
  __setGoogleTokenDepsForTest({
    query: (async () => {
      calls.queries += 1;
      return stored;
    }) as any,
    mutate: (async (_fn: unknown, args: any) => {
      calls.saved.push(args);
      return { updated: 1 };
    }) as any,
    encryptSecret: (value: string) => `enc(${value})`,
    decryptSecret: (value: string) => value.replace(/^enc\((.*)\)$/, '$1'),
    refreshGoogleAccessToken: (async ({ refreshToken }: { refreshToken: string }) => {
      calls.refreshes.push(refreshToken);
      return refresh
        ? refresh(refreshToken)
        : { access_token: `fresh-${calls.refreshes.length}`, expires_in: 3600 };
    }) as any,
    markGrantNeedsReconnect: (async (grantId: string | undefined, detail: string) => {
      calls.marked.push({ grantId, detail });
      return true;
    }) as any,
    now: () => now,
  });
  return { calls, advance: (ms: number) => (now += ms) };
}

const row = (overrides: Record<string, unknown> = {}) => ({
  userId: 'user-1',
  accountId: 'acct-1',
  email: 'ann@example.com',
  scopes: [],
  refreshTokenEncrypted: 'enc(refresh-1)',
  ...overrides,
});

describe('getGoogleAccessToken', () => {
  test('uses a stored token that is still valid, then the memory cache', async () => {
    const { calls } = harness(row({ accessTokenEncrypted: 'enc(stored)', expiresAt: NOW + 30 * 60_000 }));
    expect(await getGoogleAccessToken(GRANT)).toBe('stored');
    expect(await getGoogleAccessToken(GRANT)).toBe('stored');
    expect(calls.queries).toBe(1);
    expect(calls.refreshes).toEqual([]);
  });

  test('refreshes an expired token once for concurrent calls and stores it encrypted', async () => {
    const { calls, advance } = harness(
      row({ accessTokenEncrypted: 'enc(old)', expiresAt: NOW + 60_000 }),
      async () => ({
        access_token: 'fresh',
        expires_in: 3599,
        refresh_token: 'rotated',
      }),
    );
    const [a, b] = await Promise.all([getGoogleAccessToken(GRANT), getGoogleAccessToken(GRANT)]);
    expect([a, b]).toEqual(['fresh', 'fresh']);
    expect(calls.refreshes).toEqual(['refresh-1']);
    // The save names the connection, so it writes one user's row only.
    expect(calls.saved).toEqual([
      {
        userId: 'user-1',
        accountId: 'acct-1',
        grantId: GRANT,
        accessTokenEncrypted: 'enc(fresh)',
        expiresAt: NOW + 3599 * 1000,
        refreshTokenEncrypted: 'enc(rotated)',
      },
    ]);
    advance(3599 * 1000 - 60_000);
    expect(await getGoogleAccessToken(GRANT)).toBe('fresh');
    expect(calls.refreshes).toHaveLength(2);
  });

  test('after Google refuses a token, the next call refreshes even if the stored token looks valid', async () => {
    harness(row({ accessTokenEncrypted: 'enc(stored)', expiresAt: NOW + 30 * 60_000 }));
    expect(await getGoogleAccessToken(GRANT)).toBe('stored');
    invalidateGoogleAccessToken(GRANT);
    expect(await getGoogleAccessToken(GRANT)).toBe('fresh-1');
    forgetGoogleAccessToken(GRANT);
    expect(await getGoogleAccessToken(GRANT)).toBe('stored');
  });

  test('invalid_grant marks the account for reconnect and throws a 401 grant-gone error', async () => {
    const { calls } = harness(row(), async () => {
      throw new GoogleApiError(401, 'invalid_grant: Token has been expired or revoked.', 'invalid_grant');
    });
    const error = (await getGoogleAccessToken(GRANT).catch((e) => e)) as GoogleApiError;
    expect(error).toBeInstanceOf(GoogleApiError);
    expect(error.statusCode).toBe(401);
    expect(error.reason).toBe('invalid_grant');
    expect(isGrantGoneError(error)).toBe(true);
    expect(calls.marked).toEqual([{ grantId: GRANT, detail: 'the mailbox sign-in expired' }]);
  });

  test('a missing token row also needs a reconnect', async () => {
    const { calls } = harness(null);
    const error = (await getGoogleAccessToken(GRANT).catch((e) => e)) as GoogleApiError;
    expect(error.statusCode).toBe(401);
    expect(calls.marked).toHaveLength(1);
  });

  test('other refresh failures pass through without a reconnect', async () => {
    const { calls } = harness(row(), async () => {
      throw new GoogleApiError(503, 'backend');
    });
    const error = (await getGoogleAccessToken(GRANT).catch((e) => e)) as GoogleApiError;
    expect(error.statusCode).toBe(503);
    expect(calls.marked).toEqual([]);
  });

  test('a failed token write does not fail the call, and a missing expiry means one hour', async () => {
    harness(row(), async () => ({ access_token: 'fresh' }));
    __setGoogleTokenDepsForTest({
      query: (async () => row()) as any,
      mutate: (async () => {
        throw new Error('convex down');
      }) as any,
      refreshGoogleAccessToken: (async () => ({ access_token: 'fresh' })) as any,
      decryptSecret: (value: string) => value,
      encryptSecret: (value: string) => value,
    });
    expect(await getGoogleAccessToken(GRANT)).toBe('fresh');
  });

  test('the memory cache keeps at most 1000 grants', async () => {
    const { calls } = harness(row({ accessTokenEncrypted: 'enc(stored)', expiresAt: NOW + 30 * 60_000 }));
    for (let index = 0; index <= 1000; index += 1) await getGoogleAccessToken(`google:acct-${index}`);
    expect(calls.queries).toBe(1001);
    await getGoogleAccessToken('google:acct-1000');
    expect(calls.queries).toBe(1001);
    await getGoogleAccessToken('google:acct-0');
    expect(calls.queries).toBe(1002);
  });

  test('a Nylas grant id is refused', async () => {
    const error = (await getGoogleAccessToken('d502cbfc-grant').catch((e) => e)) as GoogleApiError;
    expect(error.statusCode).toBe(400);
  });
});

function fetchReturning(status: number, body: unknown) {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    return new Response(body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body), {
      status,
    });
  };
  return { fetcher, seen };
}

const CLIENT = { clientId: 'cid', clientSecret: 'csecret' };

describe('Google OAuth client', () => {
  test('mail credentials win over the Drive fallback; none means not configured', () => {
    expect(
      googleOAuthClient({
        GOOGLE_MAIL_CLIENT_ID: 'm',
        GOOGLE_MAIL_CLIENT_SECRET: 's',
        GOOGLE_DRIVE_CLIENT_ID: 'd',
        GOOGLE_DRIVE_CLIENT_SECRET: 'ds',
      }),
    ).toEqual({ clientId: 'm', clientSecret: 's' });
    expect(
      googleOAuthClient({
        GOOGLE_MAIL_CLIENT_ID: 'm',
        GOOGLE_DRIVE_CLIENT_ID: 'd',
        GOOGLE_DRIVE_CLIENT_SECRET: 'ds',
      }),
    ).toEqual({ clientId: 'd', clientSecret: 'ds' });
    expect(googleOAuthClient({})).toBeNull();
    expect(() => requireGoogleOAuthClient({})).toThrow('not configured');
  });

  test('the authorization URL asks for the decided scopes, offline access, consent, and PKCE', () => {
    const { codeVerifier, codeChallenge } = pkcePair();
    expect(codeVerifier.length).toBeGreaterThan(80);
    const url = new URL(
      buildGoogleMailAuthorizationUrl({
        clientId: 'cid',
        state: 'st',
        codeChallenge,
        loginHint: 'ann@example.com',
        redirectUri: 'https://mail.example/api/files/oauth/callback',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')?.split(' ')).toEqual([...GOOGLE_MAIL_SCOPES]);
    expect(url.searchParams.get('scope')?.split(' ')).toHaveLength(8);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    // No incremental grant: mail and Drive can share one OAuth client.
    expect(url.searchParams.has('include_granted_scopes')).toBe(false);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(codeChallenge);
    expect(url.searchParams.get('login_hint')).toBe('ann@example.com');
    expect(url.searchParams.get('redirect_uri')).toBe('https://mail.example/api/files/oauth/callback');
    expect(url.searchParams.get('state')).toBe('st');
  });

  test('the code exchange sends the verifier and redirect URI', async () => {
    const { fetcher, seen } = fetchReturning(200, {
      access_token: 'a',
      refresh_token: 'r',
      expires_in: 3599,
    });
    const token = await exchangeGoogleAuthorizationCode({
      code: 'code-1',
      codeVerifier: 'ver',
      client: CLIENT,
      redirectUri: 'https://mail.example/cb',
      fetch: fetcher,
    });
    expect(token.refresh_token).toBe('r');
    const body = new URLSearchParams(String(seen[0].init?.body));
    expect(seen[0].url).toBe('https://oauth2.googleapis.com/token');
    expect(Object.fromEntries(body)).toEqual({
      client_id: 'cid',
      client_secret: 'csecret',
      code: 'code-1',
      code_verifier: 'ver',
      redirect_uri: 'https://mail.example/cb',
      grant_type: 'authorization_code',
    });
  });

  test('token endpoint errors: invalid_grant is a 401, others keep their status', async () => {
    const dead = fetchReturning(400, {
      error: 'invalid_grant',
      error_description: 'Token has been expired or revoked.',
    });
    const error = (await refreshGoogleAccessToken({
      refreshToken: 'r',
      client: CLIENT,
      fetch: dead.fetcher,
    }).catch((e) => e)) as GoogleApiError;
    expect(error.statusCode).toBe(401);
    expect(error.reason).toBe('invalid_grant');
    expect(error.message).toContain('invalid_grant');
    const body = new URLSearchParams(String(dead.seen[0].init?.body));
    expect(body.get('grant_type')).toBe('refresh_token');

    const broken = fetchReturning(500, 'not json');
    const serverError = (await exchangeGoogleAuthorizationCode({
      code: 'c',
      codeVerifier: 'v',
      client: CLIENT,
      fetch: broken.fetcher,
    }).catch((e) => e)) as GoogleApiError;
    expect(serverError.statusCode).toBe(500);

    const empty = fetchReturning(200, {});
    expect(
      (
        (await refreshGoogleAccessToken({ refreshToken: 'r', client: CLIENT, fetch: empty.fetcher }).catch(
          (e) => e,
        )) as GoogleApiError
      ).statusCode,
    ).toBe(502);
    expect(
      (
        (await exchangeGoogleAuthorizationCode({
          code: 'c',
          codeVerifier: 'v',
          client: CLIENT,
          fetch: empty.fetcher,
        }).catch((e) => e)) as GoogleApiError
      ).statusCode,
    ).toBe(502);
  });

  test('revoke treats 200 and 400 as done and throws on other answers', async () => {
    expect(await revokeGoogleToken('t', fetchReturning(200, {}).fetcher)).toBe(true);
    expect(await revokeGoogleToken('t', fetchReturning(400, { error: 'invalid_token' }).fetcher)).toBe(true);
    await expect(revokeGoogleToken('t', fetchReturning(503, {}).fetcher)).rejects.toThrow('503');
  });

  test('profile and userinfo reads', async () => {
    expect(
      await fetchGmailProfile(
        'a',
        fetchReturning(200, { emailAddress: 'ann@example.com', historyId: 991 }).fetcher,
      ),
    ).toEqual({
      emailAddress: 'ann@example.com',
      historyId: '991',
    });
    await expect(fetchGmailProfile('a', fetchReturning(200, {}).fetcher)).rejects.toThrow('History id');
    await expect(fetchGmailProfile('a', fetchReturning(403, {}).fetcher)).rejects.toThrow('Gmail profile');
    expect(
      await fetchGoogleUserInfo(
        'a',
        fetchReturning(200, { email: 'ann@example.com', name: 'Ann', email_verified: true }).fetcher,
      ),
    ).toEqual({ email: 'ann@example.com', name: 'Ann', emailVerified: true });
    expect(await fetchGoogleUserInfo('a', fetchReturning(200, 'x').fetcher)).toEqual({
      email: undefined,
      name: undefined,
      emailVerified: undefined,
    });
    await expect(fetchGoogleUserInfo('a', fetchReturning(401, {}).fetcher)).rejects.toThrow('profile');
  });

  test('granted scopes are split and unique', () => {
    expect(grantedScopes({ scope: 'openid  openid https://www.googleapis.com/auth/gmail.modify' })).toEqual([
      'openid',
      'https://www.googleapis.com/auth/gmail.modify',
    ]);
    expect(grantedScopes({})).toEqual([]);
  });
});
