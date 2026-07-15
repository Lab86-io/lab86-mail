import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  __setMcpConnectionDepsForTest,
  disconnectConnection,
  getConnectionToken,
  listUserConnections,
  saveOAuthConnection,
  saveTokenConnection,
  setConnectionToggles,
} from '../lib/mcp/connections';

const NOW = 1_760_000_000_000;
const granolaRow = {
  connectionId: 'granola_conn',
  server: 'granola',
  serverUrl: 'https://mcp.granola.ai/mcp',
  authKind: 'oauth',
  status: 'connected',
  scopes: ['mcp'],
  includeInBrief: true,
  includeInSearch: true,
} as const;

let mutations: Array<{ fn: unknown; args: Record<string, unknown> }> = [];
let queryResult: unknown = null;

beforeEach(() => {
  mutations = [];
  queryResult = null;
  __setMcpConnectionDepsForTest({
    now: () => NOW,
    convexQuery: (async () => queryResult) as any,
    convexMutation: (async (fn: unknown, args: Record<string, unknown>) => {
      mutations.push({ fn, args });
      return { ok: true };
    }) as any,
    encryptSecret: (value: string) => `encrypted:${value}`,
    decryptSecret: (value: string) => {
      if (!value.startsWith('encrypted:')) throw new Error('bad ciphertext');
      return value.slice('encrypted:'.length);
    },
    secretFingerprint: () => 'fingerprint1234',
    maskFingerprint: () => '...1234',
    refreshMcpOAuth: async ({ persisted }) => ({
      ...persisted,
      clientInformation: persisted.clientInformation,
      tokens: {
        access_token: 'access_refreshed',
        refresh_token: 'refresh_rotated',
        token_type: 'Bearer',
        expires_in: 7200,
        scope: 'mcp profile',
      },
    }),
  } as any);
});

afterAll(() => __setMcpConnectionDepsForTest());

describe('MCP connection persistence', () => {
  test('stores Granola OAuth credentials encrypted with sync metadata', async () => {
    const result = await saveOAuthConnection({
      userId: 'user_1',
      server: 'granola',
      displayName: 'Work meetings',
      persisted: {
        state: 'state_1',
        clientInformation: { client_id: 'client_1' },
        tokens: {
          access_token: 'access_1',
          refresh_token: 'refresh_1',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'mcp',
        },
      },
    });

    expect(result.connectionId).toStartWith('granola_');
    expect(mutations[0]?.args).toMatchObject({
      userId: 'user_1',
      server: 'granola',
      authKind: 'oauth',
      displayName: 'Work meetings',
      accessTokenEncrypted: 'encrypted:access_1',
      refreshTokenEncrypted: 'encrypted:refresh_1',
      oauthClientInformationEncrypted: 'encrypted:{"client_id":"client_1"}',
      scopes: ['mcp'],
      fingerprint: 'fingerprint1234',
      masked: '...1234',
    });
    expect(typeof mutations[0]?.args.expiresAt).toBe('number');
  });

  test('rejects OAuth on token servers and incomplete OAuth credentials', async () => {
    await expect(
      saveOAuthConnection({ userId: 'user_1', server: 'github', persisted: { state: 'state_1' } }),
    ).rejects.toThrow('OAuth is not supported');
    await expect(
      saveOAuthConnection({ userId: 'user_1', server: 'granola', persisted: { state: 'state_1' } }),
    ).rejects.toThrow('incomplete');
  });

  test('keeps browser-only OAuth servers out of the token path', async () => {
    await expect(
      saveTokenConnection({ userId: 'user_1', server: 'granola', token: 'token' }),
    ).rejects.toThrow('browser authorization');
  });
});

describe('MCP OAuth token reads', () => {
  test('returns an unexpired decrypted token without refreshing', async () => {
    queryResult = {
      connection: granolaRow,
      credentials: { accessTokenEncrypted: 'encrypted:access_1', expiresAt: NOW + 120_000 },
    };

    expect(await getConnectionToken('user_1', 'granola_conn')).toEqual({
      row: granolaRow,
      token: 'access_1',
    });
    expect(mutations).toHaveLength(0);
  });

  test('refreshes an expiring token and persists rotated credentials', async () => {
    queryResult = {
      connection: granolaRow,
      credentials: {
        accessTokenEncrypted: 'encrypted:access_1',
        refreshTokenEncrypted: 'encrypted:refresh_1',
        oauthClientInformationEncrypted: 'encrypted:{"client_id":"client_1"}',
        expiresAt: NOW + 30_000,
      },
    };

    expect(await getConnectionToken('user_1', 'granola_conn')).toEqual({
      row: granolaRow,
      token: 'access_refreshed',
    });
    expect(mutations[0]?.args).toMatchObject({
      userId: 'user_1',
      connectionId: 'granola_conn',
      accessTokenEncrypted: 'encrypted:access_refreshed',
      refreshTokenEncrypted: 'encrypted:refresh_rotated',
      scopes: ['mcp', 'profile'],
    });
  });

  test('shares one refresh across concurrent callers and preserves expiry when omitted', async () => {
    let refreshCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    queryResult = {
      connection: granolaRow,
      credentials: {
        accessTokenEncrypted: 'encrypted:access_1',
        refreshTokenEncrypted: 'encrypted:refresh_1',
        oauthClientInformationEncrypted: 'encrypted:{"client_id":"client_1"}',
        expiresAt: NOW,
      },
    };
    __setMcpConnectionDepsForTest({
      now: () => NOW,
      convexQuery: (async () => queryResult) as any,
      convexMutation: (async (fn: unknown, args: Record<string, unknown>) => {
        mutations.push({ fn, args });
        return { ok: true };
      }) as any,
      encryptSecret: (value: string) => `encrypted:${value}`,
      decryptSecret: (value: string) => value.slice('encrypted:'.length),
      refreshMcpOAuth: async ({ persisted }) => {
        refreshCalls += 1;
        await gate;
        return {
          ...persisted,
          tokens: { access_token: 'shared_access', token_type: 'Bearer' },
          clientInformation: persisted.clientInformation,
        };
      },
    } as any);

    const first = getConnectionToken('user_1', 'granola_conn');
    const second = getConnectionToken('user_1', 'granola_conn');
    await Promise.resolve();
    expect(refreshCalls).toBe(1);
    release();

    expect((await Promise.all([first, second])).map((result) => result?.token)).toEqual([
      'shared_access',
      'shared_access',
    ]);
    expect(mutations).toHaveLength(1);
    expect(mutations[0]?.args).not.toHaveProperty('expiresAt');
  });

  test('fails closed for missing, unreadable, or unrefreshable credentials', async () => {
    expect(await getConnectionToken('user_1', 'missing')).toBeNull();

    queryResult = { connection: granolaRow, credentials: { accessTokenEncrypted: 'invalid' } };
    expect(await getConnectionToken('user_1', 'invalid')).toBeNull();

    queryResult = {
      connection: granolaRow,
      credentials: { accessTokenEncrypted: 'encrypted:access_1', expiresAt: NOW },
    };
    expect(await getConnectionToken('user_1', 'missing_refresh')).toBeNull();

    __setMcpConnectionDepsForTest({
      now: () => NOW,
      convexQuery: (async () => queryResult) as any,
      convexMutation: (async (fn: unknown, args: Record<string, unknown>) => {
        mutations.push({ fn, args });
        return undefined;
      }) as any,
      decryptSecret: (value: string) => {
        if (!value.startsWith('encrypted:')) throw new Error('bad ciphertext');
        return value.slice('encrypted:'.length);
      },
      refreshMcpOAuth: async () => {
        throw new Error('refresh rejected');
      },
    } as any);
    queryResult = {
      connection: granolaRow,
      credentials: {
        accessTokenEncrypted: 'encrypted:access_1',
        refreshTokenEncrypted: 'encrypted:refresh_1',
        oauthClientInformationEncrypted: 'encrypted:{"client_id":"client_1"}',
        expiresAt: NOW,
      },
    };
    expect(await getConnectionToken('user_1', 'refresh_rejected')).toBeNull();
  });

  test('does not return a rotated access token when credential persistence is rejected', async () => {
    queryResult = {
      connection: granolaRow,
      credentials: {
        accessTokenEncrypted: 'encrypted:access_1',
        refreshTokenEncrypted: 'encrypted:refresh_1',
        oauthClientInformationEncrypted: 'encrypted:{"client_id":"client_1"}',
        expiresAt: NOW,
      },
    };
    __setMcpConnectionDepsForTest({
      now: () => NOW,
      convexQuery: (async () => queryResult) as any,
      convexMutation: (async (fn: unknown, args: Record<string, unknown>) => {
        mutations.push({ fn, args });
        return { ok: false };
      }) as any,
      encryptSecret: (value: string) => `encrypted:${value}`,
      decryptSecret: (value: string) => value.slice('encrypted:'.length),
      refreshMcpOAuth: async ({ persisted }) => ({
        ...persisted,
        clientInformation: persisted.clientInformation,
        tokens: {
          access_token: 'access_refreshed',
          refresh_token: 'refresh_rotated',
          token_type: 'Bearer',
        },
      }),
    });

    expect(await getConnectionToken('user_1', 'granola_conn')).toBeNull();
    expect(mutations).toHaveLength(1);
  });
});

test('lists, disconnects, and updates connection toggles through Convex', async () => {
  queryResult = [granolaRow];
  expect(await listUserConnections('user_1')).toEqual([granolaRow]);
  await disconnectConnection('user_1', 'granola_conn');
  await setConnectionToggles('user_1', 'granola_conn', { includeInBrief: false });

  expect(mutations.map(({ args }) => args)).toEqual([
    { userId: 'user_1', connectionId: 'granola_conn' },
    { userId: 'user_1', connectionId: 'granola_conn', includeInBrief: false },
  ]);
});
