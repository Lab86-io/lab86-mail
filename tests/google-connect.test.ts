import { afterEach, describe, expect, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import {
  __setGoogleConnectDepsForTest,
  completeGoogleMailConnect,
  directGoogleConnectChoice,
  finalizeGoogleMailConnect,
  GoogleConnectError,
  handleGoogleMailCallback,
  isGoogleDirectSwitchAllowed,
  kickAfterConnect,
  startGoogleMailConnect,
} from '../lib/google/connect';
import { GMAIL_MODIFY_SCOPE } from '../lib/google/oauth';

const USER = 'user-1';
const NYLAS_ACCOUNT = {
  userId: USER,
  accountId: 'acct-1',
  email: 'ann@example.com',
  provider: 'google' as const,
  status: 'connected',
  grantId: 'nylas-grant-1',
  scopes: [],
};
const DIRECT_DEAD = {
  ...NYLAS_ACCOUNT,
  accountId: 'acct-2',
  email: 'bo@example.com',
  grantId: 'google:acct-2',
  status: 'error',
};
const OUTLOOK = {
  ...NYLAS_ACCOUNT,
  accountId: 'acct-3',
  email: 'cy@outlook.com',
  provider: 'microsoft' as const,
  grantId: 'nylas-3',
};

interface Harness {
  mutations: Array<{ name: string; args: any }>;
  afterConnect: any[];
  exchanges: any[];
}

function setup(
  overrides: {
    env?: Record<string, string | undefined>;
    accounts?: any[];
    client?: { clientId: string; clientSecret: string } | null;
    tokens?: any;
    profile?: { emailAddress: string; historyId: string };
    session?: { userId: string } | null;
    consumeState?: any;
    consumeCompletion?: any;
    activation?: any;
    defaultAfterConnect?: boolean;
  } = {},
): Harness {
  const harness: Harness = { mutations: [], afterConnect: [], exchanges: [] };
  __setGoogleConnectDepsForTest({
    query: (async () => overrides.accounts ?? [NYLAS_ACCOUNT, DIRECT_DEAD, OUTLOOK]) as any,
    mutate: (async (fn: unknown, args: any) => {
      const name = getFunctionName(fn as any);
      harness.mutations.push({ name, args });
      if (name === 'googleDirect:consumeOAuthState') {
        if (overrides.consumeState instanceof Error) throw overrides.consumeState;
        return overrides.consumeState ?? null;
      }
      if (name === 'googleDirect:consumeOAuthCompletion') return overrides.consumeCompletion ?? null;
      if (name === 'googleDirect:activateGoogleAccount') {
        return (
          overrides.activation ?? {
            accountId: args.accountId ?? args.newAccountId,
            grantId: `google:${args.accountId ?? args.newAccountId}`,
            outcome: args.accountId ? 'switched' : 'created',
          }
        );
      }
      return { ok: true };
    }) as any,
    encryptSecret: (value: string) => `enc(${value})`,
    decryptSecret: (value: string) => value.replace(/^enc\((.*)\)$/, '$1'),
    googleOAuthClient: () =>
      overrides.client === undefined ? { clientId: 'cid', clientSecret: 'cs' } : overrides.client,
    exchangeGoogleAuthorizationCode: (async (input: any) => {
      harness.exchanges.push(input);
      return (
        overrides.tokens ?? {
          access_token: 'access',
          refresh_token: 'refresh',
          expires_in: 3599,
          scope: `openid ${GMAIL_MODIFY_SCOPE} https://www.googleapis.com/auth/calendar`,
        }
      );
    }) as any,
    fetchGmailProfile: async () => overrides.profile ?? { emailAddress: 'Ann@Example.com', historyId: '777' },
    fetchGoogleUserInfo: async () => ({ name: 'Ann Lee' }),
    requireCurrentUser: (async () => {
      if (overrides.session === null) throw new Error('signed out');
      return overrides.session ?? { userId: USER };
    }) as any,
    randomState: () => 'random-state-with-enough-length-for-tokens-000',
    randomUUID: () => 'uuid-new',
    now: () => 1_800_000_000_000,
    env: () => overrides.env ?? {},
    ...(overrides.defaultAfterConnect
      ? {
          maybeKickCorpusBackfill: ((input: any) =>
            harness.afterConnect.push({ kick: 'backfill', ...input })) as any,
          reconcileMailCorpusAccount: (async () => ({ ok: true })) as any,
          syncCalendarAccount: (async () => ({ ok: true })) as any,
          maybeKickContactSync: (() => undefined) as any,
        }
      : {
          afterConnect: (input: any) => {
            harness.afterConnect.push(input);
          },
        }),
  });
  return harness;
}

afterEach(() => __setGoogleConnectDepsForTest());

describe('switch gate', () => {
  test('on with the flag, the switch flag, or on staging; off in production', () => {
    const saved = process.env.RAILWAY_ENVIRONMENT_NAME;
    const savedNodeEnv = process.env.NODE_ENV;
    const savedBasic = process.env.LAB86_MAIL_REQUIRE_BASIC_AUTH;
    process.env.RAILWAY_ENVIRONMENT_NAME = 'production';
    (process.env as any).NODE_ENV = 'test';
    delete process.env.LAB86_MAIL_REQUIRE_BASIC_AUTH;
    try {
      expect(isGoogleDirectSwitchAllowed({})).toBe(false);
      expect(isGoogleDirectSwitchAllowed({ LAB86_GOOGLE_DIRECT: '1' })).toBe(true);
      expect(isGoogleDirectSwitchAllowed({ LAB86_GOOGLE_DIRECT_SWITCH: '1' })).toBe(true);
      expect(isGoogleDirectSwitchAllowed({}, 'mail-staging.lab86.io')).toBe(true);
      process.env.RAILWAY_ENVIRONMENT_NAME = 'development';
      expect(isGoogleDirectSwitchAllowed({})).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.RAILWAY_ENVIRONMENT_NAME;
      else process.env.RAILWAY_ENVIRONMENT_NAME = saved;
      (process.env as any).NODE_ENV = savedNodeEnv;
      if (savedBasic !== undefined) process.env.LAB86_MAIL_REQUIRE_BASIC_AUTH = savedBasic;
    }
  });
});

describe('startGoogleMailConnect', () => {
  test('a switch by email saves an encrypted PKCE state and hints the account', async () => {
    const harness = setup({ env: { LAB86_GOOGLE_DIRECT_SWITCH: '1' } });
    const started = await startGoogleMailConnect({
      userId: USER,
      mode: 'switch',
      account: 'ANN@example.com',
      redirectTo: '/settings',
    });
    expect(started.mode).toBe('switch');
    expect(started.accountId).toBe('acct-1');
    const url = new URL(started.authorizationUrl);
    expect(url.searchParams.get('login_hint')).toBe('ann@example.com');
    expect(url.searchParams.get('state')).toBe('random-state-with-enough-length-for-tokens-000');
    expect(url.searchParams.get('client_id')).toBe('cid');
    const saved = harness.mutations[0];
    expect(saved.name).toBe('googleDirect:saveOAuthState');
    expect(saved.args).toMatchObject({
      userId: USER,
      mode: 'switch',
      accountId: 'acct-1',
      redirectTo: '/settings',
      nativeCallback: false,
      expiresAt: 1_800_000_000_000 + 10 * 60_000,
    });
    expect(saved.args.codeVerifierEncrypted).toMatch(/^enc\(.{80,}\)$/);
  });

  test('an account on Gmail already reconnects, even when switching is off', async () => {
    setup({ env: {} });
    const started = await startGoogleMailConnect({
      userId: USER,
      mode: 'switch',
      account: 'acct-2',
      native: true,
    });
    expect(started.mode).toBe('reconnect');
  });

  test('refusals: unknown account, another provider, switching off, new off, no client', async () => {
    setup({ env: {} });
    const saved = process.env.RAILWAY_ENVIRONMENT_NAME;
    process.env.RAILWAY_ENVIRONMENT_NAME = 'production';
    try {
      const status = async (input: Parameters<typeof startGoogleMailConnect>[0]) =>
        ((await startGoogleMailConnect(input).catch((e) => e)) as GoogleConnectError).status;
      expect(await status({ userId: USER, mode: 'switch', account: 'nobody@example.com' })).toBe(404);
      expect(await status({ userId: USER, mode: 'switch' })).toBe(404);
      expect(await status({ userId: USER, mode: 'switch', account: 'acct-3' })).toBe(400);
      expect(await status({ userId: USER, mode: 'switch', account: 'acct-1', host: 'mail.lab86.io' })).toBe(
        403,
      );
      expect(await status({ userId: USER, mode: 'new' })).toBe(404);
      setup({ client: null });
      expect(await status({ userId: USER, mode: 'new' })).toBe(503);
    } finally {
      if (saved === undefined) delete process.env.RAILWAY_ENVIRONMENT_NAME;
      else process.env.RAILWAY_ENVIRONMENT_NAME = saved;
    }
  });

  test('new works with the flag and sanitizes the return path', async () => {
    const harness = setup({ env: { LAB86_GOOGLE_DIRECT: '1' } });
    const started = await startGoogleMailConnect({ userId: USER, mode: 'new', redirectTo: '//evil.example' });
    expect(new URL(started.authorizationUrl).searchParams.has('login_hint')).toBe(false);
    expect(harness.mutations[0].args).toMatchObject({ mode: 'new', accountId: undefined, redirectTo: '/' });
  });
});

describe('directGoogleConnectChoice', () => {
  test('the flag sends Google connections to Gmail; an old native build stays on Nylas', async () => {
    setup({ env: { LAB86_GOOGLE_DIRECT: '1' } });
    expect(await directGoogleConnectChoice({ userId: USER })).toEqual({ mode: 'new' });
    expect(await directGoogleConnectChoice({ userId: USER, native: true })).toBeNull();
    expect(await directGoogleConnectChoice({ userId: USER, native: true, finalize: true })).toEqual({
      mode: 'new',
    });
  });

  test('with the flag off, only a dead direct account reconnects directly', async () => {
    setup({ env: {} });
    expect(await directGoogleConnectChoice({ userId: USER })).toEqual({
      mode: 'reconnect',
      account: 'acct-2',
    });
    setup({ env: {}, accounts: [NYLAS_ACCOUNT] });
    expect(await directGoogleConnectChoice({ userId: USER })).toBeNull();
    setup({ env: { LAB86_GOOGLE_DIRECT: '1' }, client: null });
    expect(await directGoogleConnectChoice({ userId: USER })).toBeNull();
  });
});

describe('completeGoogleMailConnect', () => {
  test('a switch checks the Gmail address and stores the tokens with the History id', async () => {
    const harness = setup();
    const result = await completeGoogleMailConnect({
      userId: USER,
      mode: 'switch',
      accountId: 'acct-1',
      code: 'code-1',
      codeVerifier: 'verifier-1',
    });
    expect(result.outcome).toBe('switched');
    expect(harness.exchanges[0]).toMatchObject({ code: 'code-1', codeVerifier: 'verifier-1' });
    const activation = harness.mutations.find((m) => m.name === 'googleDirect:activateGoogleAccount');
    expect(activation?.args).toEqual({
      userId: USER,
      mode: 'switch',
      accountId: 'acct-1',
      newAccountId: 'uuid-new',
      email: 'ann@example.com',
      displayName: 'Ann Lee',
      scopes: ['openid', GMAIL_MODIFY_SCOPE, 'https://www.googleapis.com/auth/calendar'],
      accessTokenEncrypted: 'enc(access)',
      refreshTokenEncrypted: 'enc(refresh)',
      expiresAt: 1_800_000_000_000 + 3599 * 1000,
      historyId: '777',
    });
    expect(harness.afterConnect).toEqual([{ userId: USER, accountId: 'acct-1', outcome: 'switched' }]);
  });

  test('another Google address is refused and nothing is stored', async () => {
    const harness = setup({ profile: { emailAddress: 'someone@else.com', historyId: '1' } });
    const error = (await completeGoogleMailConnect({
      userId: USER,
      mode: 'switch',
      accountId: 'acct-1',
      code: 'c',
      codeVerifier: 'v',
    }).catch((e) => e)) as GoogleConnectError;
    expect(error.status).toBe(409);
    expect(error.message).toContain('ann@example.com');
    expect(harness.mutations.some((m) => m.name === 'googleDirect:activateGoogleAccount')).toBe(false);
    expect(harness.afterConnect).toEqual([]);
  });

  test('refusals: no refresh token, no Gmail scope, a missing account, no client', async () => {
    setup({ tokens: { access_token: 'a', scope: GMAIL_MODIFY_SCOPE } });
    const input = {
      userId: USER,
      mode: 'switch' as const,
      accountId: 'acct-1',
      code: 'c',
      codeVerifier: 'v',
    };
    expect(((await completeGoogleMailConnect(input).catch((e) => e)) as GoogleConnectError).status).toBe(409);
    setup({ tokens: { access_token: 'a', refresh_token: 'r', scope: 'openid' } });
    expect(((await completeGoogleMailConnect(input).catch((e) => e)) as GoogleConnectError).status).toBe(403);
    setup({ accounts: [] });
    expect(((await completeGoogleMailConnect(input).catch((e) => e)) as GoogleConnectError).status).toBe(404);
    setup({ client: null });
    expect(((await completeGoogleMailConnect(input).catch((e) => e)) as GoogleConnectError).status).toBe(503);
  });

  test('the default hook runs the kicks after the connection is stored', async () => {
    const harness = setup({
      defaultAfterConnect: true,
      tokens: { access_token: 'a', refresh_token: 'r', scope: GMAIL_MODIFY_SCOPE },
      profile: { emailAddress: 'new@example.com', historyId: '9' },
    });
    await completeGoogleMailConnect({ userId: USER, mode: 'new', code: 'c', codeVerifier: 'v' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(harness.afterConnect).toEqual([{ kick: 'backfill', userId: USER, accountId: 'uuid-new' }]);
  });

  test('new creates an account without an address check and a default expiry', async () => {
    const harness = setup({
      tokens: { access_token: 'a', refresh_token: 'r', scope: GMAIL_MODIFY_SCOPE },
      profile: { emailAddress: 'new@example.com', historyId: '9' },
    });
    const result = await completeGoogleMailConnect({
      userId: USER,
      mode: 'new',
      code: 'c',
      codeVerifier: 'v',
    });
    expect(result).toMatchObject({ accountId: 'uuid-new', outcome: 'created' });
    const activation = harness.mutations.find((m) => m.name === 'googleDirect:activateGoogleAccount');
    expect(activation?.args.expiresAt).toBe(1_800_000_000_000 + 3600 * 1000);
    expect(harness.afterConnect[0].outcome).toBe('created');
  });
});

describe('handleGoogleMailCallback', () => {
  const state = (overrides: Record<string, unknown> = {}) => ({
    userId: USER,
    mode: 'switch',
    accountId: 'acct-1',
    redirectTo: '/settings',
    nativeCallback: false,
    codeVerifierEncrypted: 'enc(verifier)',
    ...overrides,
  });

  test('a state that is not a Google mail state goes back to the Files flow', async () => {
    setup({ consumeState: null });
    expect(await handleGoogleMailCallback({ state: 'files-state', code: 'c' })).toBeNull();
    expect(await handleGoogleMailCallback({ state: '', code: 'c' })).toBeNull();
    setup({ consumeState: new Error('convex down') });
    expect(await handleGoogleMailCallback({ state: 'x', code: 'c' })).toBeNull();
  });

  test('the web callback needs the same signed-in user, then completes the switch', async () => {
    setup({ consumeState: state(), session: { userId: 'intruder' } });
    const refused = await handleGoogleMailCallback({ state: 's', code: 'c' });
    expect(refused?.headers.get('location')).toContain('nylas_error=Sign+in+again');
    const harness = setup({ consumeState: state() });
    const done = await handleGoogleMailCallback({ state: 's', code: 'code-1' });
    const location = new URL(done?.headers.get('location') || '');
    expect(location.pathname).toBe('/settings');
    expect(location.searchParams.get('nylas_connected')).toBe('1');
    expect(location.searchParams.get('google_mail')).toBe('switched');
    expect(harness.exchanges[0].codeVerifier).toBe('verifier');
    setup({ consumeState: state(), session: null });
    expect((await handleGoogleMailCallback({ state: 's', code: 'c' }))?.headers.get('location')).toContain(
      'nylas_error',
    );
  });

  test('a native callback stores a completion token and opens the app', async () => {
    const harness = setup({
      consumeState: state({ nativeCallback: true, mode: 'new', accountId: undefined }),
    });
    const response = await handleGoogleMailCallback({ state: 's', code: 'code-9' });
    const location = new URL(response?.headers.get('location') || '');
    expect(`${location.protocol}//${location.host}${location.pathname}`).toBe('lab86://oauth/mail');
    expect(location.searchParams.get('mail_completion')).toBe(
      'random-state-with-enough-length-for-tokens-000',
    );
    const saved = harness.mutations.find((m) => m.name === 'googleDirect:saveOAuthCompletion');
    expect(saved?.args).toMatchObject({
      userId: USER,
      mode: 'new',
      authorizationCodeEncrypted: 'enc(code-9)',
      codeVerifierEncrypted: 'enc(verifier)',
      expiresAt: 1_800_000_000_000 + 5 * 60_000,
    });
    expect(harness.exchanges).toEqual([]);
  });

  test('provider errors, a missing code, and a failed completion show a safe message', async () => {
    setup({ consumeState: state() });
    const denied = await handleGoogleMailCallback({
      state: 's',
      code: '',
      providerError: 'access_denied: private detail',
    });
    expect(denied?.headers.get('location')).toContain('Authorization+was+not+completed');
    expect(denied?.headers.get('location')).not.toContain('private');
    setup({ consumeState: state() });
    expect((await handleGoogleMailCallback({ state: 's', code: '' }))?.headers.get('location')).toContain(
      'did+not+return+an+authorization+code',
    );
    setup({ consumeState: state(), profile: { emailAddress: 'other@x.org', historyId: '1' } });
    expect((await handleGoogleMailCallback({ state: 's', code: 'c' }))?.headers.get('location')).toContain(
      'Sign+in+to+Google+as+ann%40example.com',
    );
    setup({ consumeState: state({ nativeCallback: true }), tokens: { access_token: 'a' } });
    // The native path saves a completion; exchange errors happen later, in finalize.
    expect((await handleGoogleMailCallback({ state: 's', code: 'c' }))?.headers.get('location')).toContain(
      'mail_completion',
    );
  });

  test('an unexpected failure shows the general message', async () => {
    setup({ consumeState: state() });
    __setGoogleConnectDepsForTest({
      mutate: (async (fn: unknown) => {
        if (getFunctionName(fn as any) === 'googleDirect:consumeOAuthState') return state();
        throw new Error('internal detail');
      }) as any,
      requireCurrentUser: (async () => ({ userId: USER })) as any,
      googleOAuthClient: () => ({ clientId: 'c', clientSecret: 's' }),
      exchangeGoogleAuthorizationCode: (async () => ({
        access_token: 'a',
        refresh_token: 'r',
        scope: GMAIL_MODIFY_SCOPE,
      })) as any,
      fetchGmailProfile: async () => ({ emailAddress: 'ann@example.com', historyId: '1' }),
      fetchGoogleUserInfo: async () => {
        throw new Error('no profile');
      },
      query: (async () => [NYLAS_ACCOUNT]) as any,
      decryptSecret: (value: string) => value,
    });
    const response = await handleGoogleMailCallback({ state: 's', code: 'c' });
    expect(response?.headers.get('location')).toContain('Could+not+complete+the+Google+connection');
    expect(response?.headers.get('location')).not.toContain('internal');
  });
});

describe('kicks after a connection', () => {
  function kicks() {
    const calls: string[] = [];
    __setGoogleConnectDepsForTest({
      maybeKickCorpusBackfill: ((input: any) => calls.push(`backfill:${input.accountId}`)) as any,
      reconcileMailCorpusAccount: (async (input: any) => {
        calls.push(`reconcile:${input.accountId}`);
        throw new Error('reconcile failed');
      }) as any,
      syncCalendarAccount: (async (input: any) => {
        calls.push(`calendar:${input.accountId}:${input.force}:${input.reason}`);
        throw new Error('calendar failed');
      }) as any,
      maybeKickContactSync: ((input: any, options: any) =>
        calls.push(`contacts:${input.accountId}:${options.force}:${options.reason}`)) as any,
    });
    return calls;
  }

  test('a new account backfills; a switched account reconciles; both force calendar and contacts', async () => {
    const created = kicks();
    await kickAfterConnect({ userId: USER, accountId: 'acct-new', outcome: 'created' });
    expect(created).toEqual([
      'backfill:acct-new',
      'calendar:acct-new:true:oauth_callback',
      'contacts:acct-new:true:oauth_callback',
    ]);
    const switched = kicks();
    await kickAfterConnect({ userId: USER, accountId: 'acct-1', outcome: 'switched' });
    expect(switched).toEqual([
      'reconcile:acct-1',
      'calendar:acct-1:true:oauth_callback',
      'contacts:acct-1:true:oauth_callback',
    ]);
  });
});

describe('finalizeGoogleMailConnect', () => {
  test('redeems a completion token of the same user once', async () => {
    const harness = setup({
      consumeCompletion: {
        mode: 'switch',
        accountId: 'acct-1',
        authorizationCodeEncrypted: 'enc(code-5)',
        codeVerifierEncrypted: 'enc(ver-5)',
      },
    });
    const result = await finalizeGoogleMailConnect({ userId: USER, completionToken: 'tok' });
    expect(result.outcome).toBe('switched');
    expect(harness.mutations[0]).toEqual({
      name: 'googleDirect:consumeOAuthCompletion',
      args: { userId: USER, completionToken: 'tok' },
    });
    expect(harness.exchanges[0]).toMatchObject({ code: 'code-5', codeVerifier: 'ver-5' });
    setup({ consumeCompletion: null });
    expect(
      (
        (await finalizeGoogleMailConnect({ userId: USER, completionToken: 'tok' }).catch(
          (e) => e,
        )) as GoogleConnectError
      ).status,
    ).toBe(409);
  });
});
