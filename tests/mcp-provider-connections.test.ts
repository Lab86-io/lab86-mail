import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createMcpOAuthStartGet } from '../app/api/mcp/oauth/start/route';
import { syncMcpContent } from '../lib/content/mcp-sync';
import { connectedItemReason } from '../lib/mail/brief-connected';
import {
  __setMcpConnectionDepsForTest,
  getConnectionToken,
  saveOAuthConnection,
} from '../lib/mcp/connections';
import { completeMcpOAuthConnection } from '../lib/mcp/oauth-connection';
import {
  connectionTransport,
  getServerDef,
  listServerDefs,
  MCP_SERVERS,
  resolveMcpConnectionConfig,
  usesProviderOAuth,
} from '../lib/mcp/servers';
import { type SyncConnectionDeps, syncConnection } from '../lib/mcp/sync';

const ENV_KEYS = [
  'ATLASSIAN_OAUTH_CLIENT_ID',
  'ATLASSIAN_OAUTH_CLIENT_SECRET',
  'BITBUCKET_OAUTH_KEY',
  'BITBUCKET_OAUTH_SECRET',
  'SLACK_OAUTH_CLIENT_ID',
  'SLACK_OAUTH_CLIENT_SECRET',
] as const;
let savedEnv: Record<string, string | undefined> = {};

function configureProviders() {
  process.env.ATLASSIAN_OAUTH_CLIENT_ID = 'atl_client';
  process.env.ATLASSIAN_OAUTH_CLIENT_SECRET = 'atl_secret';
  process.env.BITBUCKET_OAUTH_KEY = 'bb_key';
  process.env.BITBUCKET_OAUTH_SECRET = 'bb_secret';
  process.env.SLACK_OAUTH_CLIENT_ID = 'slack_client';
  process.env.SLACK_OAUTH_CLIENT_SECRET = 'slack_secret';
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('provider sign-in in the server definitions', () => {
  test('a provider keeps the token form until its OAuth app is set', () => {
    expect(getServerDef('slack')).toMatchObject({ connectMode: 'token', label: 'Slack' });
    expect(getServerDef('jira')).toMatchObject({ connectMode: 'token', label: 'Atlassian / Jira' });
    expect(usesProviderOAuth(getServerDef('jira')!)).toBe(false);

    configureProviders();
    expect(getServerDef('jira')).toMatchObject({
      connectMode: 'oauth',
      label: 'Atlassian',
      tokenLabel: 'Atlassian sign-in',
      transport: 'mcp',
    });
    expect(getServerDef('jira')?.tokenHelp).toContain('Confluence');
    expect(usesProviderOAuth(getServerDef('bitbucket')!)).toBe(true);
    // Granola keeps its MCP sign-in, and GitHub keeps its token.
    expect(usesProviderOAuth(getServerDef('granola')!)).toBe(false);
    expect(listServerDefs().map((def) => [def.id, def.connectMode])).toEqual([
      ['github', 'token'],
      ['bitbucket', 'oauth'],
      ['jira', 'oauth'],
      ['slack', 'oauth'],
      ['granola', 'oauth'],
    ]);
    expect(getServerDef('nope')).toBeNull();
    expect(getServerDef('slack', {})?.connectMode).toBe('token');
  });

  test('a saved connection picks its transport from how it signed in', () => {
    expect(connectionTransport(MCP_SERVERS.jira, 'oauth')).toBe('atlassian-rest');
    expect(connectionTransport(MCP_SERVERS.jira, 'token')).toBe('mcp');
    expect(connectionTransport(MCP_SERVERS.slack, 'oauth')).toBe('slack-rest');
    expect(connectionTransport(MCP_SERVERS.bitbucket, 'oauth')).toBe('bitbucket-rest');
    expect(connectionTransport(MCP_SERVERS.granola, 'oauth')).toBe('mcp');
  });

  test('a provider sign-in keeps its granted scopes and URL', () => {
    expect(
      resolveMcpConnectionConfig(
        'jira',
        'https://api.atlassian.com/',
        ['read:jira-work', 'read:me'],
        'oauth',
      ),
    ).toEqual({
      serverUrl: 'https://api.atlassian.com',
      scopes: ['read:jira-work', 'read:me'],
      migrated: false,
    });
    expect(resolveMcpConnectionConfig('slack', '', [], 'oauth').serverUrl).toBe('https://slack.com/api');
    // A token connection still migrates to the server defaults.
    expect(resolveMcpConnectionConfig('slack', '', [], 'token')).toMatchObject({ migrated: true });
  });
});

describe('provider connections', () => {
  const NOW = 1_760_000_000_000;
  let mutations: Array<Record<string, any>> = [];
  let queryResult: unknown = null;
  const refreshProviderOAuth = mock(async () => ({
    access_token: 'atl_new',
    refresh_token: 'atl_refresh_2',
    token_type: 'Bearer',
    expires_in: 3600,
  }));

  beforeEach(() => {
    configureProviders();
    mutations = [];
    queryResult = null;
    refreshProviderOAuth.mockClear();
    __setMcpConnectionDepsForTest({
      now: () => NOW,
      convexQuery: (async () => queryResult) as any,
      convexMutation: (async (_fn: unknown, args: Record<string, any>) => {
        mutations.push(args);
        return { ok: true };
      }) as any,
      encryptSecret: (value: string) => `encrypted:${value}`,
      decryptSecret: (value: string) => value.slice('encrypted:'.length),
      secretFingerprint: () => 'fp',
      maskFingerprint: () => '...fp',
      refreshMcpOAuth: async () => {
        throw new Error('a provider connection must not use MCP refresh');
      },
      refreshProviderOAuth,
    } as any);
  });

  afterAll(() => __setMcpConnectionDepsForTest());

  test('saves a provider sign-in with the REST API URL and the granted scopes', async () => {
    await saveOAuthConnection({
      userId: 'user_1',
      server: 'jira',
      persisted: {
        state: 's',
        provider: 'atlassian',
        clientInformation: { client_id: 'atl_client', provider: 'atlassian' } as any,
        tokens: { access_token: 'atl_access', token_type: 'Bearer', scope: 'read:jira-work offline_access' },
      },
    });
    const upsert = mutations.find((args) => args.authKind === 'oauth');
    expect(upsert).toMatchObject({
      server: 'jira',
      serverUrl: 'https://api.atlassian.com',
      displayName: 'Atlassian',
      scopes: ['read:jira-work', 'offline_access'],
      oauthClientInformationEncrypted: 'encrypted:{"client_id":"atl_client","provider":"atlassian"}',
    });
  });

  test('refreshes an expiring provider token at the provider and saves the rotated token', async () => {
    const row = {
      connectionId: 'jira_1',
      server: 'jira',
      serverUrl: 'https://api.atlassian.com',
      authKind: 'oauth',
      status: 'connected',
      scopes: ['read:jira-work'],
      includeInBrief: true,
      includeInSearch: true,
    };
    queryResult = {
      connection: row,
      credentials: {
        accessTokenEncrypted: 'encrypted:atl_old',
        refreshTokenEncrypted: 'encrypted:atl_refresh_1',
        oauthClientInformationEncrypted: 'encrypted:{"client_id":"atl_client","provider":"atlassian"}',
        expiresAt: NOW + 10_000,
      },
    };
    expect(await getConnectionToken('user_1', 'jira_1')).toEqual<unknown>({ row, token: 'atl_new' });
    expect(refreshProviderOAuth.mock.calls[0]).toEqual([
      { provider: 'atlassian', refreshToken: 'atl_refresh_1' },
    ] as any);
    expect(mutations[0]).toMatchObject({
      accessTokenEncrypted: 'encrypted:atl_new',
      refreshTokenEncrypted: 'encrypted:atl_refresh_2',
      oauthClientInformationEncrypted: 'encrypted:{"client_id":"atl_client","provider":"atlassian"}',
      scopes: ['read:jira-work'],
    });
    expect(typeof mutations[0]?.expiresAt).toBe('number');
  });
});

describe('provider OAuth completion', () => {
  beforeEach(configureProviders);

  test('finishes a provider sign-in at the provider, not through MCP discovery', async () => {
    const finishProviderOAuth = mock(async (input: any) => ({
      ...input.persisted,
      tokens: { access_token: 'bb', token_type: 'Bearer' },
      clientInformation: { client_id: 'bb_key', provider: 'bitbucket' },
    }));
    const result = await completeMcpOAuthConnection(
      {
        userId: 'user_1',
        server: 'bitbucket',
        code: 'code_1',
        persisted: { state: 's', provider: 'bitbucket' },
      },
      {
        finishProviderOAuth: finishProviderOAuth as any,
        finishMcpOAuth: async () => {
          throw new Error('MCP finish must not run');
        },
        saveOAuthConnection: async () => ({ connectionId: 'bitbucket_1' }),
        syncConnection: async () => ({ ok: true, count: 3 }),
      },
    );
    expect(result).toEqual({ ok: true, label: 'Bitbucket', connectionId: 'bitbucket_1' });
    expect(finishProviderOAuth.mock.calls[0]?.[0]).toMatchObject({ provider: 'bitbucket', code: 'code_1' });
  });

  test('refuses a provider sign-in that belongs to another server', async () => {
    await expect(
      completeMcpOAuthConnection(
        { userId: 'user_1', server: 'slack', code: 'c', persisted: { state: 's', provider: 'atlassian' } },
        {
          saveOAuthConnection: async () => ({ connectionId: 'x' }),
          syncConnection: async () => ({ ok: true, count: 0 }),
        },
      ),
    ).rejects.toThrow('OAuth provider did not match the server.');
  });
});

describe('MCP OAuth start route with a provider app', () => {
  test('starts the provider sign-in for a configured provider', async () => {
    configureProviders();
    const beginProviderOAuth = mock(() => ({
      authorizationUrl: 'https://slack.com/oauth/v2/authorize?client_id=slack_client',
      persisted: { state: 'state-1', provider: 'slack' as const },
    }));
    const saveOAuthState = mock(async (..._args: unknown[]) => ({ ok: true }));
    const response = await createMcpOAuthStartGet({
      requireCurrentUser: async () => ({ userId: 'user_1' }) as any,
      enforceUserRateLimit: async () => ({ ok: true }) as any,
      getServerDef,
      beginMcpOAuth: async () => {
        throw new Error('MCP discovery must not run for Slack');
      },
      beginProviderOAuth,
      saveOAuthState,
      encryptSecret: (value: string) => `encrypted:${value}`,
      randomState: () => 'state-1',
      now: () => 0,
      reportUnexpectedError: () => undefined,
    })(new NextRequest('http://localhost/api/mcp/oauth/start?server=slack&format=json'));
    expect(await response.json()).toEqual({
      ok: true,
      authorizationUrl: 'https://slack.com/oauth/v2/authorize?client_id=slack_client',
    });
    expect(beginProviderOAuth.mock.calls[0]).toEqual([{ provider: 'slack', state: 'state-1' }] as any);
    expect((saveOAuthState.mock.calls[0]?.[0] as any).payloadEncrypted).toBe(
      'encrypted:{"state":"state-1","provider":"slack"}',
    );
  });
});

describe('provider connection sync', () => {
  function oauthRow(server: 'jira' | 'slack' | 'bitbucket', serverUrl: string) {
    return {
      connectionId: `${server}_1`,
      server,
      serverUrl,
      authKind: 'oauth',
      status: 'connected',
      scopes: [],
      includeInBrief: true,
      includeInSearch: true,
    } as const;
  }

  function deps(row: any, overrides: Partial<SyncConnectionDeps>, mutations: Array<Record<string, any>>) {
    return {
      getConnectionToken: async () => ({ row, token: 'token-1' }),
      listUserConnections: async () => [row],
      convexMutation: async (_fn: unknown, args: Record<string, any>) => {
        mutations.push(args);
        return undefined as any;
      },
      loadBitbucketItems: async () => ({ items: [], workspaces: ['acme', 'labs'] }),
      loadGitHubItems: async () => ({ items: [] }),
      loadAtlassianItems: async () => ({ items: [], problems: [] }),
      loadSlackItems: async () => ({ items: [], problems: [] }),
      connectMcp: async () => {
        throw new Error('a provider connection must not open MCP');
      },
      callMcpTool: async () => undefined,
      ...overrides,
    } as unknown as SyncConnectionDeps;
  }

  const item = { externalId: 'jira:c:1', kind: 'ticket', title: 'PAY-1', searchText: 'PAY-1' };

  test('an Atlassian sign-in syncs through the REST loader and saves the account and sites', async () => {
    const mutations: Array<Record<string, any>> = [];
    const row = oauthRow('jira', 'https://api.atlassian.com');
    const loadAtlassianItems = mock(async () => ({
      items: [item],
      problems: [],
      accountEmail: 'j@acme.test',
      workspaceName: 'acme, beta',
    }));
    const result = await syncConnection(
      'user_1',
      row.connectionId,
      deps(row, { loadAtlassianItems }, mutations),
    );
    expect(result).toEqual({ ok: true, count: 1 });
    expect(loadAtlassianItems.mock.calls[0]).toEqual(['https://api.atlassian.com', 'token-1'] as any);
    expect(mutations.find((args) => args.items)?.items).toEqual([item]);
    expect(mutations.at(-1)).toMatchObject({
      status: 'ready',
      outcome: 'ok',
      itemCount: 1,
      accountEmail: 'j@acme.test',
      workspaceName: 'acme, beta',
    });
  });

  test('a partial Slack sync keeps the connection and records the problem', async () => {
    const mutations: Array<Record<string, any>> = [];
    const row = oauthRow('slack', 'https://slack.com/api');
    const result = await syncConnection(
      'user_1',
      row.connectionId,
      deps(
        row,
        {
          loadSlackItems: async () => ({
            items: [{ ...item, externalId: 'slack:1' }],
            problems: ['Slack search hit a rate limit'],
            workspaceName: 'Acme',
          }),
        },
        mutations,
      ),
    );
    expect(result).toEqual({ ok: false, count: 1, error: 'Slack search hit a rate limit' });
    expect(mutations.at(-1)).toMatchObject({
      status: 'error',
      error: 'Slack search hit a rate limit',
      outcome: 'ok',
      workspaceName: 'Acme',
    });
  });

  test('a rejected provider sign-in asks for a reconnect with sign-in wording', async () => {
    const mutations: Array<Record<string, any>> = [];
    const row = oauthRow('slack', 'https://slack.com/api');
    const result = await syncConnection(
      'user_1',
      row.connectionId,
      deps(
        row,
        {
          loadSlackItems: async () => {
            throw Object.assign(new Error('Slack auth probe failed: token_revoked'), { statusCode: 401 });
          },
        },
        mutations,
      ),
    );
    expect(result.error).toBe('sign-in rejected — reconnect to sign in again');
    expect(mutations.at(-1)).toMatchObject({ status: 'error', outcome: 'reconnect' });
  });

  test('a Bitbucket sync names the workspaces it reached', async () => {
    const mutations: Array<Record<string, any>> = [];
    const row = oauthRow('bitbucket', 'https://api.bitbucket.org/2.0');
    await syncConnection('user_1', row.connectionId, deps(row, {}, mutations));
    expect(mutations.at(-1)).toMatchObject({ status: 'ready', workspaceName: 'acme, labs' });
  });
});

describe('provider history walk', () => {
  function harness(server: 'slack' | 'jira' | 'bitbucket', cursor: Record<string, unknown> | null) {
    const writes: Array<Record<string, any>> = [];
    const calls: Array<{ name: string; args: unknown[] }> = [];
    const record =
      (name: string, result: unknown) =>
      async (...args: unknown[]) => {
        calls.push({ name, args });
        return result;
      };
    const row = {
      connectionId: `${server}_1`,
      server,
      serverUrl: 'https://api.example.test',
      authKind: 'oauth',
      status: 'connected',
      includeInSearch: true,
      includeInBrief: true,
    };
    const deps: any = {
      listUserConnections: async () => [row],
      getConnectionToken: async () => ({ row, token: 'token-1' }),
      connectMcp: async () => {
        throw new Error('a provider history walk must not open MCP');
      },
      callMcpTool: async () => undefined,
      convexMutation: async (_ref: any, args: any) => {
        writes.push(args);
        return { lease: 'lease', cursor };
      },
      loadSlackHistoryPage: record('slackPage', {
        items: [{ externalId: 's1' }],
        next: { query: 0, page: 2 },
      }),
      loadSlackChangedMessages: record('slackChanged', [{ externalId: 's2' }]),
      loadAtlassianHistoryPage: record('atlassianPage', {
        items: [{ externalId: 'j1' }],
        next: { site: 1, token: 't2' },
      }),
      loadAtlassianChangedIssues: record('atlassianChanged', []),
    };
    return { deps, writes, calls };
  }

  test('a Slack walk saves its query and page, and an Atlassian walk saves its site and page token', async () => {
    const slack = harness('slack', { query: 0, page: 1 });
    await syncMcpContent('user_1', slack.deps);
    expect(slack.calls[0]?.name).toBe('slackPage');
    expect(slack.calls[0]?.args.slice(0, 3)).toEqual([
      'https://api.example.test',
      'token-1',
      { query: 0, page: 1 },
    ]);
    expect(slack.writes.find((w) => w.items)?.items).toEqual([{ externalId: 's1' }]);
    expect(slack.writes.at(-1)).toMatchObject({
      status: 'indexing',
      cursor: { query: 0, page: 2 },
      indexed: 1,
    });

    const jira = harness('jira', { site: 0, pageToken: 't1' });
    await syncMcpContent('user_1', jira.deps);
    expect(jira.calls[0]?.args[2]).toEqual({ site: 0, token: 't1' });
    expect(jira.writes.at(-1)).toMatchObject({ status: 'indexing', cursor: { site: 1, pageToken: 't2' } });
  });

  test('the walk ends, and a later pass reads only changed items', async () => {
    const ending = harness('jira', null);
    ending.deps.loadAtlassianHistoryPage = async () => ({ items: [] });
    await syncMcpContent('user_1', ending.deps);
    expect(ending.writes.at(-1)).toMatchObject({ status: 'provider_limited', cursor: { complete: true } });

    const recheck = harness('slack', { complete: true, checkedAt: Date.now() - 2 * 3_600_000 });
    await syncMcpContent('user_1', recheck.deps);
    expect(recheck.calls.map((c) => c.name)).toEqual(['slackChanged']);
    expect(recheck.writes.at(-1)).toMatchObject({ status: 'provider_limited', indexed: 1 });

    const atlassian = harness('jira', { complete: true, checkedAt: Date.now() - 2 * 3_600_000 });
    await syncMcpContent('user_1', atlassian.deps);
    expect(atlassian.calls.map((c) => c.name)).toEqual(['atlassianChanged']);
  });

  test('a Bitbucket sign-in has no history walk', async () => {
    const bitbucket = harness('bitbucket', null);
    await syncMcpContent('user_1', bitbucket.deps);
    expect(bitbucket.writes).toEqual([]);
  });
});

describe('brief source labels', () => {
  test('a Confluence page from the Atlassian sign-in reads as Confluence', () => {
    const base = {
      server: 'jira' as const,
      connectionId: 'jira_1',
      externalId: 'confluence:c:1',
      title: 'Plan',
      updatedAt: 1,
    };
    expect(connectedItemReason({ ...base, kind: 'page' } as any)).toBe('Confluence page');
    expect(
      connectedItemReason({ ...base, kind: 'ticket', state: 'In Progress', assignedToUser: true } as any),
    ).toBe('Jira ticket, in progress, assigned to you');
  });
});
