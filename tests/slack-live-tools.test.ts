import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  __setMcpConnectionDepsForTest,
  accountConnectionId,
  saveOAuthConnection,
} from '../lib/mcp/connections';
import { finishProviderOAuth, providerAccount } from '../lib/mcp/provider-oauth';
import { allowsMultipleAccounts, getServerDef } from '../lib/mcp/servers';
import { parseSlackPermalink, readSlackThread, searchSlackLive } from '../lib/mcp/slack';
import { __setSlackToolDepsForTest, slackReadThread, slackSearch } from '../lib/tools/slack';

const API = 'https://slack.com/api';
const SLACK_ENV = ['SLACK_OAUTH_CLIENT_ID', 'SLACK_OAUTH_CLIENT_SECRET'] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(SLACK_ENV.map((key) => [key, process.env[key]]));
  process.env.SLACK_OAUTH_CLIENT_ID = 'slack_client';
  process.env.SLACK_OAUTH_CLIENT_SECRET = 'slack_secret';
});

afterEach(() => {
  for (const key of SLACK_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function slackFetch(handler: (url: URL) => Response) {
  const calls: URL[] = [];
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url);
    return handler(url);
  }) as typeof fetch;
  return { fetchFn, calls };
}

const auth = () => json({ ok: true, team: 'Acme', team_id: 'T1', user: 'ada', user_id: 'U1' });

function match(ts: string, channel = { id: 'C1', name: 'eng' }) {
  return {
    ts,
    text: 'Launch moves to Friday',
    permalink: `https://acme.slack.com/archives/${channel.id}/p${ts.replace('.', '')}`,
    team: 'T1',
    username: 'jane',
    channel,
  };
}

describe('Slack workspace accounts', () => {
  test('a Slack token answer names its workspace member', () => {
    expect(
      providerAccount('slack', { team: { id: 'T1', name: ' Acme ' }, authed_user: { id: 'U1' } }),
    ).toEqual({
      id: 'T1:U1',
      name: 'Acme',
    });
    expect(providerAccount('slack', { team: { id: 'T1' } })).toBeUndefined();
    expect(providerAccount('atlassian', { team: { id: 'T1' }, authed_user: { id: 'U1' } })).toBeUndefined();
  });

  test('finishing a Slack sign-in keeps the workspace account', async () => {
    const fetchFn = (async () =>
      json({
        ok: true,
        team: { id: 'T9', name: 'Beta' },
        authed_user: { id: 'U9', access_token: 'xoxp-9' },
      })) as unknown as typeof fetch;
    const finished = await finishProviderOAuth({
      provider: 'slack',
      code: 'c',
      persisted: { state: 's', provider: 'slack' },
      fetchFn,
    });
    expect(finished.account).toEqual({ id: 'T9:U9', name: 'Beta' });
  });

  test('Slack allows several workspaces only with its app set', () => {
    expect(allowsMultipleAccounts(getServerDef('slack')!)).toBe(true);
    expect(allowsMultipleAccounts(getServerDef('jira')!)).toBe(false);
    delete process.env.SLACK_OAUTH_CLIENT_SECRET;
    expect(allowsMultipleAccounts(getServerDef('slack')!)).toBe(false);
  });

  test('each workspace member gets one stable connection', async () => {
    expect(accountConnectionId('slack', 'T1:U1')).toBe('slack_t1u1');
    expect(accountConnectionId('slack', '::')).toMatch(/^slack_[0-9a-f]{16}$/);

    const mutations: Array<Record<string, any>> = [];
    __setMcpConnectionDepsForTest({
      convexQuery: (async () => [
        // A broken connection of another workspace must stay as it is.
        { connectionId: 'slack_old', server: 'slack', status: 'error' },
      ]) as any,
      convexMutation: (async (_fn: unknown, args: Record<string, any>) => {
        mutations.push(args);
        return { ok: true };
      }) as any,
      encryptSecret: (value: string) => `encrypted:${value}`,
      secretFingerprint: () => 'fp',
      maskFingerprint: () => '...fp',
    } as any);
    const saved = await saveOAuthConnection({
      userId: 'user_1',
      server: 'slack',
      displayName: 'Slack',
      persisted: {
        state: 's',
        provider: 'slack',
        account: { id: 'T2:U1', name: 'Beta' },
        clientInformation: { client_id: 'slack_client', provider: 'slack' } as any,
        tokens: { access_token: 'xoxp-2', token_type: 'Bearer' },
      },
    });
    expect(saved.connectionId).toBe('slack_t2u1');
    expect(mutations[0]).toMatchObject({
      connectionId: 'slack_t2u1',
      serverUrl: 'https://slack.com/api',
      displayName: 'Slack',
    });
  });
});

afterAll(() => __setMcpConnectionDepsForTest());

describe('Slack live reads', () => {
  test('a live search reads the workspace by relevance or time and stores nothing', async () => {
    const mock = slackFetch((url) =>
      url.pathname === '/api/auth.test'
        ? auth()
        : json({ ok: true, messages: { total: 42, matches: [match('1760000000.000100')] } }),
    );
    const found = await searchSlackLive({
      baseUrl: API,
      token: 'xoxp-1',
      query: 'launch in:#eng',
      count: 500,
      fetchFn: mock.fetchFn,
    });
    const search = mock.calls.find((url) => url.pathname === '/api/search.messages')!;
    expect(search.searchParams.get('query')).toBe('launch in:#eng');
    expect(search.searchParams.get('sort')).toBe('score');
    expect(search.searchParams.get('count')).toBe('100');
    expect(found).toMatchObject({ workspaceName: 'Acme', total: 42 });
    expect(found.items[0]).toMatchObject({
      externalId: 'slack:T1:C1:1760000000.000100',
      organization: 'Acme',
    });

    const newest = slackFetch((url) =>
      url.pathname === '/api/auth.test' ? auth() : json({ ok: true, messages: { matches: [] } }),
    );
    const empty = await searchSlackLive({
      baseUrl: API,
      token: 'xoxp-1',
      query: 'x',
      count: 0,
      sort: 'newest',
      fetchFn: newest.fetchFn,
    });
    expect(newest.calls[1]?.searchParams.get('sort')).toBe('timestamp');
    expect(newest.calls[1]?.searchParams.get('count')).toBe('1');
    expect(empty).toEqual({ workspaceName: 'Acme', items: [] });
  });

  test('a message link gives its channel, time, and thread', () => {
    expect(parseSlackPermalink('https://acme.slack.com/archives/C123/p1508284197000015')).toEqual({
      host: 'acme.slack.com',
      channel: 'C123',
      ts: '1508284197.000015',
    });
    expect(
      parseSlackPermalink(
        'https://acme.slack.com/archives/C123/p1508284197000015?thread_ts=1508284100.000001&cid=C123',
      )?.threadTs,
    ).toBe('1508284100.000001');
    expect(parseSlackPermalink('https://acme.slack.com/messages/C123')).toBeNull();
    expect(parseSlackPermalink('not a link')).toBeNull();
  });

  test('a thread read names its authors and keeps the oldest message first', async () => {
    const mock = slackFetch((url) => {
      if (url.pathname === '/api/conversations.replies') {
        expect(url.searchParams.get('limit')).toBe('15');
        return json({
          ok: true,
          has_more: true,
          messages: [
            { user: 'U2', text: 'Launch moves to <#C9|ops>?', ts: '1760000000.000100' },
            { user: 'U3', text: 'Yes', ts: '1760000060.000200' },
            { bot_id: 'B1', text: 'Reminder', ts: '1760000120.000300' },
          ],
        });
      }
      if (url.searchParams.get('user') === 'U2') {
        return json({ ok: true, user: { name: 'jane', profile: { display_name: 'Jane' } } });
      }
      return json({ ok: false, error: 'user_not_found' });
    });
    const thread = await readSlackThread({
      baseUrl: API,
      token: 'xoxp-1',
      channel: 'C1',
      ts: '1760000000.000100',
      fetchFn: mock.fetchFn,
    });
    expect(thread.hasMore).toBe(true);
    expect(thread.messages).toEqual([
      {
        author: 'Jane',
        text: 'Launch moves to #ops?',
        ts: '1760000000.000100',
        at: '2025-10-09T08:53:20.000Z',
      },
      { author: 'U3', text: 'Yes', ts: '1760000060.000200', at: '2025-10-09T08:54:20.000Z' },
      { author: 'B1', text: 'Reminder', ts: '1760000120.000300', at: '2025-10-09T08:55:20.000Z' },
    ]);
  });
});

describe('Slack assistant tools', () => {
  const rows = [
    {
      connectionId: 'slack_t1u1',
      server: 'slack',
      authKind: 'oauth',
      status: 'connected',
      serverUrl: API,
      workspaceName: 'Acme',
      includeInSearch: true,
    },
    {
      connectionId: 'slack_t2u1',
      server: 'slack',
      authKind: 'oauth',
      status: 'connected',
      serverUrl: API,
      workspaceName: 'Beta',
      includeInSearch: true,
    },
    // Not searchable: a token connection, a workspace with search off, and another tool.
    {
      connectionId: 'slack_tok',
      server: 'slack',
      authKind: 'token',
      status: 'connected',
      includeInSearch: true,
    },
    {
      connectionId: 'slack_off',
      server: 'slack',
      authKind: 'oauth',
      status: 'connected',
      includeInSearch: false,
    },
    { connectionId: 'jira_1', server: 'jira', authKind: 'oauth', status: 'connected', includeInSearch: true },
  ] as any[];
  const ctx = { userId: 'user_1' } as any;

  function item(id: string, updatedAtSource: number) {
    return {
      externalId: id,
      kind: 'message',
      title: id,
      summary: 'text',
      author: 'jane',
      url: `https://x.test/${id}`,
      updatedAtSource,
      raw: { channel: 'C1', channelName: 'eng', ts: '1.0' },
      searchText: id,
    };
  }

  afterAll(() => __setSlackToolDepsForTest());

  test('slack_search reads every connected workspace and takes turns by relevance', async () => {
    const searched: string[] = [];
    __setSlackToolDepsForTest({
      listUserConnections: async () => rows,
      getConnectionToken: async (_user: string, connectionId: string) =>
        connectionId === 'slack_t2u1' ? null : ({ row: rows[0], token: `token-${connectionId}` } as any),
      searchSlackLive: async (input: any) => {
        searched.push(input.token);
        return { workspaceName: 'Acme', total: 2, items: [item('a1', 1), item('a2', 3)] as any };
      },
    });
    const result = await slackSearch.handler({ query: 'launch', sort: 'relevance', limit: 20 } as any, ctx);
    expect(searched).toEqual(['token-slack_t1u1']);
    expect(result.items.map((row: any) => row.title)).toEqual(['a1', 'a2']);
    expect(result.items[0]).toMatchObject({
      server: 'slack',
      connectionId: 'slack_t1u1',
      workspace: 'Acme',
      channel: 'C1',
      ts: '1.0',
      updatedAtIso: '1970-01-01T00:00:00.001Z',
    });
    expect(result.workspaces).toEqual([
      { connectionId: 'slack_t1u1', name: 'Acme', ok: true, total: 2 },
      {
        connectionId: 'slack_t2u1',
        name: 'Beta',
        ok: false,
        total: null,
        error: 'Reconnect this workspace in Settings.',
      },
    ]);
  });

  test('slack_search sorts by time, filters by workspace, and explains an empty answer', async () => {
    __setSlackToolDepsForTest({
      listUserConnections: async () => rows,
      getConnectionToken: async (_user: string, connectionId: string) =>
        ({ row: rows.find((row) => row.connectionId === connectionId), token: connectionId }) as any,
      searchSlackLive: async (input: any) => {
        if (input.token === 'slack_t2u1') throw new Error('Slack search hit a rate limit');
        return { workspaceName: 'Acme', items: [item('old', 1), item('new', 9)] as any };
      },
    });
    const newest = await slackSearch.handler({ query: 'x', sort: 'newest', limit: 1 } as any, ctx);
    expect(newest.items.map((row: any) => row.title)).toEqual(['new']);
    expect(newest.workspaces[1]).toMatchObject({
      ok: false,
      error: 'Slack asked the app to wait. Try again in a minute.',
    });

    const beta = await slackSearch.handler(
      { query: 'x', workspace: 'beta', sort: 'relevance', limit: 5 } as any,
      ctx,
    );
    expect(beta.workspaces.map((row: any) => row.connectionId)).toEqual(['slack_t2u1']);
    const missing = await slackSearch.handler(
      { query: 'x', workspace: 'gamma', sort: 'relevance', limit: 5 } as any,
      ctx,
    );
    expect(missing).toEqual({
      items: [],
      workspaces: [],
      note: 'No connected Slack workspace matches "gamma".',
    });

    __setSlackToolDepsForTest({ listUserConnections: async () => [] });
    const none = await slackSearch.handler({ query: 'x', sort: 'relevance', limit: 5 } as any, ctx);
    expect(none.note).toContain('No Slack workspace is connected');
    await expect(slackSearch.handler({ query: 'x' } as any, { userId: null } as any)).rejects.toThrow(
      'Not authenticated.',
    );
  });

  test('slack_read_thread reads a thread from an item or a message link', async () => {
    const reads: Array<Record<string, unknown>> = [];
    __setSlackToolDepsForTest({
      listUserConnections: async () => rows,
      getConnectionToken: async () => ({ row: rows[0], token: 'xoxp-1' }) as any,
      readSlackThread: async (input: any) => {
        reads.push({ channel: input.channel, ts: input.ts });
        return { messages: [{ author: 'Jane', text: 'Yes', ts: '1.0' }], hasMore: false };
      },
    });
    const fromItem = await slackReadThread.handler(
      { connectionId: 'slack_t1u1', channel: 'C1', ts: '1.0' } as any,
      ctx,
    );
    expect(fromItem).toEqual({
      ok: true,
      workspace: 'Acme',
      messages: [{ author: 'Jane', text: 'Yes', ts: '1.0' }],
      hasMore: false,
    });
    const link = 'https://acme.slack.com/archives/C7/p1508284197000015?thread_ts=1508284100.000001';
    const fromLink = await slackReadThread.handler(
      { connectionId: 'slack_t2u1', permalink: link } as any,
      ctx,
    );
    expect(fromLink).toMatchObject({ ok: true, workspace: 'Beta', url: link });
    expect(reads.at(-1)).toEqual({ channel: 'C7', ts: '1508284100.000001' });

    // Two workspaces and no connectionId: the tool asks for it.
    expect(await slackReadThread.handler({ channel: 'C1', ts: '1.0' } as any, ctx)).toEqual({
      ok: false,
      error: 'Pass the connectionId of the workspace from the slack_search item.',
    });
    expect(await slackReadThread.handler({ connectionId: 'slack_t1u1' } as any, ctx)).toMatchObject({
      ok: false,
      error: 'Pass channel and ts from a slack_search item, or a Slack message link.',
    });
  });

  test('slack_read_thread uses the only workspace and reports a Slack wait', async () => {
    __setSlackToolDepsForTest({
      listUserConnections: async () => [rows[0]],
      getConnectionToken: async () => ({ row: rows[0], token: 'xoxp-1' }) as any,
      readSlackThread: async () => {
        throw new Error('Slack thread read hit a rate limit');
      },
    });
    expect(await slackReadThread.handler({ channel: 'C1', ts: '1.0' } as any, ctx)).toEqual({
      ok: false,
      workspace: 'Acme',
      error: 'Slack asked the app to wait. Try again in a minute.',
    });

    __setSlackToolDepsForTest({
      listUserConnections: async () => [rows[0]],
      getConnectionToken: async () => null,
    });
    expect(await slackReadThread.handler({ channel: 'C1', ts: '1.0' } as any, ctx)).toMatchObject({
      ok: false,
      error: 'Reconnect this workspace in Settings.',
    });

    __setSlackToolDepsForTest({
      listUserConnections: async () => [rows[0]],
      getConnectionToken: async () => ({ row: rows[0], token: 'xoxp-1' }) as any,
      readSlackThread: async () => {
        throw new Error('Slack thread read failed: channel_not_found');
      },
    });
    expect(await slackReadThread.handler({ channel: 'C1', ts: '1.0' } as any, ctx)).toMatchObject({
      error: 'Slack thread read failed: channel_not_found',
    });

    __setSlackToolDepsForTest({ listUserConnections: async () => [] });
    expect(await slackReadThread.handler({ channel: 'C1', ts: '1.0' } as any, ctx)).toEqual({
      ok: false,
      error: 'No Slack workspace is connected for search.',
    });
  });
});
