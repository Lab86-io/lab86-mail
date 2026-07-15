import { describe, expect, test } from 'bun:test';
import type { SyncConnectionDeps } from '../lib/mcp/sync';

const bitbucketRow = {
  connectionId: 'bitbucket_conn',
  server: 'bitbucket',
  serverUrl: 'https://api.bitbucket.org/2.0',
  authKind: 'token',
  status: 'connected',
  scopes: [],
  includeInBrief: true,
  includeInSearch: true,
} as const;

function depsFor(overrides: Partial<SyncConnectionDeps> = {}): SyncConnectionDeps {
  return {
    getConnectionToken: async () => null,
    listUserConnections: async () => [],
    convexMutation: async () => undefined,
    loadBitbucketItems: async () => ({ items: [] }),
    loadGitHubItems: async () => ({ items: [], viewer: 'octocat' }),
    connectMcp: async () => {
      throw new Error('connectMcp should not be called');
    },
    callMcpTool: async () => {
      throw new Error('callMcpTool should not be called');
    },
    ...overrides,
  } as SyncConnectionDeps;
}

describe('MCP syncConnection state transitions', () => {
  test('records missing credentials and rejects unknown server definitions', async () => {
    const mutations: Array<Record<string, any>> = [];
    const { syncConnection } = await import('../lib/mcp/sync');
    const missing = await syncConnection(
      'user_1',
      'missing_conn',
      depsFor({
        convexMutation: async (_fn, args) => {
          mutations.push(args);
          return undefined as any;
        },
      }),
    );
    const unknown = await syncConnection(
      'user_1',
      'unknown_conn',
      depsFor({
        getConnectionToken: async () => ({
          row: { ...bitbucketRow, server: 'unknown', connectionId: 'unknown_conn' } as any,
          token: 'token',
        }),
      }),
    );

    expect(missing).toEqual({ ok: false, count: 0, error: 'missing credentials' });
    expect(mutations[0]).toMatchObject({ status: 'error', error: 'missing or unreadable credentials' });
    expect(unknown).toEqual({ ok: false, count: 0, error: 'unknown server' });
  });

  test('stores Bitbucket items and marks the connection ready', async () => {
    const mutations: Array<Record<string, any>> = [];
    const item = {
      externalId: 'https://bitbucket.org/lab86/mail/pull-requests/42',
      kind: 'pull_request',
      title: 'Add Bitbucket sync',
      state: 'open',
      searchText: 'Add Bitbucket sync',
    };
    const { syncConnection } = await import('../lib/mcp/sync');

    const result = await syncConnection(
      'user_1',
      bitbucketRow.connectionId,
      depsFor({
        getConnectionToken: async () => ({ row: bitbucketRow as any, token: 'person@example.com:api-token' }),
        loadBitbucketItems: async (baseUrl, token) => {
          expect(baseUrl).toBe(bitbucketRow.serverUrl);
          expect(token).toBe('person@example.com:api-token');
          return { items: [item] };
        },
        convexMutation: async (_fn, args) => {
          mutations.push(args);
          return undefined as any;
        },
      }),
    );

    expect(result).toEqual({ ok: true, count: 1 });
    expect(mutations.map((mutation) => mutation.status).filter(Boolean)).toEqual(['syncing', 'ready']);
    expect(mutations.find((mutation) => Array.isArray(mutation.items))?.items).toEqual([item]);
    expect(mutations.at(-1)).toMatchObject({
      userId: 'user_1',
      connectionId: bitbucketRow.connectionId,
      server: 'bitbucket',
      status: 'ready',
      itemCount: 1,
    });
  });

  test('marks Bitbucket auth failures as terminal errors', async () => {
    const mutations: Array<Record<string, any>> = [];
    const { syncConnection } = await import('../lib/mcp/sync');

    const result = await syncConnection(
      'user_1',
      bitbucketRow.connectionId,
      depsFor({
        getConnectionToken: async () => ({ row: bitbucketRow as any, token: 'expired' }),
        loadBitbucketItems: async () => {
          throw Object.assign(new Error('HTTP 401'), { statusCode: 401 });
        },
        convexMutation: async (_fn, args) => {
          mutations.push(args);
          return undefined as any;
        },
      }),
    );

    expect(result).toEqual({
      ok: false,
      count: 0,
      error: 'auth rejected — reconnect with a valid token',
    });
    expect(mutations.map((mutation) => mutation.status).filter(Boolean)).toEqual(['syncing', 'error']);
    expect(mutations.at(-1)).toMatchObject({
      server: 'bitbucket',
      status: 'error',
      error: 'auth rejected — reconnect with a valid token',
    });
  });

  test('migrates legacy GitHub connections and loads evidence through the direct read API', async () => {
    const mutations: Array<Record<string, any>> = [];
    const { syncConnection } = await import('../lib/mcp/sync');

    const result = await syncConnection(
      'user_1',
      'github_conn',
      depsFor({
        getConnectionToken: async () => ({
          row: {
            connectionId: 'github_conn',
            server: 'github',
            serverUrl: 'https://api.githubcopilot.com/mcp/readonly',
            authKind: 'token',
            status: 'connected',
            scopes: ['issues:read', 'pull_requests:read'],
            includeInBrief: true,
            includeInSearch: true,
          } as any,
          token: 'ghp_123',
        }),
        loadGitHubItems: async (serverUrl, token) => {
          expect(serverUrl).toContain('api.github.com');
          expect(token).toBe('ghp_123');
          return {
            viewer: 'octocat',
            items: [
              {
                externalId: 'github:issue:lab86/mail#123',
                kind: 'issue',
                title: 'Investigate CI flakes',
                state: 'open',
                author: 'octocat',
                repository: 'lab86/mail',
                organization: 'lab86',
                searchText: 'Investigate CI flakes issue lab86/mail',
              },
              {
                externalId: 'github:project:PVT_1',
                kind: 'project',
                title: 'Albatross',
                state: 'open',
                searchText: 'Albatross project',
              },
              {
                externalId: 'github:commit:lab86/mail:abc',
                kind: 'commit',
                title: 'Tighten the intent loop',
                repository: 'lab86/mail',
                sha: 'abc',
                searchText: 'Tighten the intent loop commit',
              },
            ],
          };
        },
        convexMutation: async (_fn, args) => {
          mutations.push(args);
          return undefined as any;
        },
      }),
    );

    expect(result).toEqual({ ok: true, count: 3 });
    expect(mutations).toContainEqual(
      expect.objectContaining({
        connectionId: 'github_conn',
        serverUrl: 'https://api.github.com',
        scopes: ['metadata:read', 'contents:read', 'issues:read', 'pull_requests:read', 'projects:read'],
      }),
    );
    expect(mutations.find((mutation) => Array.isArray(mutation.items))?.items[0]).toMatchObject({
      externalId: 'github:issue:lab86/mail#123',
      kind: 'issue',
      title: 'Investigate CI flakes',
      state: 'open',
      author: 'octocat',
    });
    expect(mutations.at(-1)).toMatchObject({ server: 'github', status: 'ready', itemCount: 3 });
  });

  test('records an error when a legacy connection cannot persist its migrated configuration', async () => {
    const mutations: Array<Record<string, any>> = [];
    let callCount = 0;
    const { syncConnection } = await import('../lib/mcp/sync');

    const result = await syncConnection(
      'user_1',
      'github_conn',
      depsFor({
        getConnectionToken: async () => ({
          row: {
            connectionId: 'github_conn',
            server: 'github',
            serverUrl: 'https://api.githubcopilot.com/mcp/readonly',
            authKind: 'token',
            status: 'error',
            scopes: ['issues:read'],
            includeInBrief: true,
            includeInSearch: true,
          } as any,
          token: 'ghp_123',
        }),
        loadGitHubItems: async () => {
          throw new Error('GitHub should not be called when migration persistence fails');
        },
        convexMutation: async (_fn, args) => {
          callCount += 1;
          if (callCount === 1) throw new Error('Convex unavailable');
          mutations.push(args);
          return undefined as any;
        },
      }),
    );

    expect(result).toEqual({ ok: false, count: 0, error: 'Convex unavailable' });
    expect(mutations).toEqual([
      expect.objectContaining({
        connectionId: 'github_conn',
        server: 'github',
        status: 'error',
        error: 'Convex unavailable',
      }),
    ]);
  });

  test('batches large connector snapshots before writing them to Convex', async () => {
    const mutations: Array<Record<string, any>> = [];
    const { syncConnection } = await import('../lib/mcp/sync');
    const items = Array.from({ length: 205 }, (_, index) => ({
      externalId: `github:commit:lab86/mail:${index}`,
      kind: 'commit',
      title: `Commit ${index}`,
      searchText: `Commit ${index}`,
    }));

    const result = await syncConnection(
      'user_1',
      'github_conn',
      depsFor({
        getConnectionToken: async () => ({
          row: {
            connectionId: 'github_conn',
            server: 'github',
            serverUrl: 'https://api.github.com',
            authKind: 'token',
            status: 'connected',
            scopes: ['metadata:read', 'contents:read', 'issues:read', 'pull_requests:read', 'projects:read'],
            includeInBrief: true,
            includeInSearch: true,
          } as any,
          token: 'ghp_123',
        }),
        loadGitHubItems: async () => ({ viewer: 'octocat', items }),
        convexMutation: async (_fn, args) => {
          mutations.push(args);
          return undefined as any;
        },
      }),
    );

    expect(result).toEqual({ ok: true, count: 205 });
    expect(
      mutations.filter((mutation) => Array.isArray(mutation.items)).map((mutation) => mutation.items.length),
    ).toEqual([100, 100, 5]);
  });

  test('marks hosted MCP connection and query failures as errors and always closes handles', async () => {
    const { syncConnection } = await import('../lib/mcp/sync');
    const jiraRow = {
      ...bitbucketRow,
      connectionId: 'jira_conn',
      server: 'jira',
      serverUrl: 'https://mcp.atlassian.com/v1/mcp',
    } as any;
    const connectFailure = await syncConnection(
      'user_1',
      jiraRow.connectionId,
      depsFor({
        getConnectionToken: async () => ({ row: jiraRow, token: 'bad' }),
        connectMcp: async () => {
          throw Object.assign(new Error('forbidden'), { statusCode: 403 });
        },
      }),
    );
    let closedUnsupported = false;
    const unsupported = await syncConnection(
      'user_1',
      jiraRow.connectionId,
      depsFor({
        getConnectionToken: async () => ({ row: jiraRow, token: 'token' }),
        connectMcp: async () =>
          ({
            toolNames: new Set(['different_tool']),
            close: async () => {
              closedUnsupported = true;
            },
          }) as any,
      }),
    );
    let closedRejected = false;
    const rejected = await syncConnection(
      'user_1',
      jiraRow.connectionId,
      depsFor({
        getConnectionToken: async () => ({ row: jiraRow, token: 'token' }),
        connectMcp: async () =>
          ({
            toolNames: new Set(['searchJiraIssuesUsingJql']),
            close: async () => {
              closedRejected = true;
            },
          }) as any,
        callMcpTool: async () => {
          throw new Error('query rejected');
        },
      }),
    );

    expect(connectFailure.error).toBe('auth rejected — reconnect with a valid token');
    expect(unsupported.error).toContain('did not expose supported tools');
    expect(rejected.error).toBe('query rejected');
    expect(closedUnsupported).toBe(true);
    expect(closedRejected).toBe(true);
  });

  test('normalizes, deduplicates, persists, and closes successful hosted MCP results', async () => {
    const mutations: Array<Record<string, any>> = [];
    let closed = false;
    const { syncConnection } = await import('../lib/mcp/sync');
    const slackRow = {
      ...bitbucketRow,
      connectionId: 'slack_conn',
      server: 'slack',
      serverUrl: 'https://mcp.slack.com/mcp/',
    } as any;
    const result = await syncConnection(
      'user_1',
      slackRow.connectionId,
      depsFor({
        getConnectionToken: async () => ({ row: slackRow, token: 'token' }),
        connectMcp: async (serverUrl) => {
          expect(serverUrl).toBe('https://mcp.slack.com/mcp');
          return {
            toolNames: new Set(['search_messages']),
            close: async () => {
              closed = true;
            },
          } as any;
        },
        callMcpTool: async (_handle, tool, args) => {
          expect(tool).toBe('search_messages');
          expect(args).toMatchObject({ query: 'is:mention' });
          return {
            structuredContent: [
              { id: 'message_1', text: 'One mention', user: 'Ada', ts: '1760000000' },
              { id: 'message_1', text: 'Duplicate mention' },
            ],
          } as any;
        },
        convexMutation: async (_fn, args) => {
          mutations.push(args);
          return undefined as any;
        },
      }),
    );

    expect(result).toEqual({ ok: true, count: 1 });
    expect(closed).toBe(true);
    expect(mutations.find((entry) => Array.isArray(entry.items))?.items).toHaveLength(1);
    expect(mutations.at(-1)).toMatchObject({ status: 'ready', itemCount: 1 });
  });

  test('enriches Granola meeting listings with notes using the advertised tool schema', async () => {
    const mutations: Array<Record<string, any>> = [];
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const { syncConnection } = await import('../lib/mcp/sync');
    const granolaRow = {
      ...bitbucketRow,
      connectionId: 'granola_conn',
      server: 'granola',
      serverUrl: 'https://mcp.granola.ai/mcp',
      authKind: 'oauth',
      scopes: ['mcp'],
    } as any;
    const result = await syncConnection(
      'user_1',
      granolaRow.connectionId,
      depsFor({
        getConnectionToken: async () => ({ row: granolaRow, token: 'oauth-access' }),
        connectMcp: async () =>
          ({
            toolNames: new Set(['list_meetings', 'get_meetings']),
            toolSchemas: new Map([
              ['get_meetings', { type: 'object', properties: { meeting_ids: { type: 'array' } } }],
            ]),
            close: async () => undefined,
          }) as any,
        callMcpTool: async (_handle, tool, args) => {
          calls.push({ tool, args });
          if (tool === 'list_meetings') {
            return {
              structuredContent: {
                meetings: [{ id: 'meeting_1', title: 'Albatross planning', date: '2026-07-15T14:00:00Z' }],
              },
            } as any;
          }
          return {
            structuredContent: {
              meetings: [
                {
                  id: 'meeting_1',
                  title: 'Albatross planning',
                  notes: { decisions: ['Ship OAuth'], actions: ['Verify staging'] },
                },
              ],
            },
          } as any;
        },
        convexMutation: async (_fn, args) => {
          mutations.push(args);
          return undefined as any;
        },
      }),
    );

    expect(result).toEqual({ ok: true, count: 1 });
    expect(calls).toEqual([
      { tool: 'list_meetings', args: {} },
      { tool: 'get_meetings', args: { meeting_ids: ['meeting_1'] } },
    ]);
    expect(mutations.find((entry) => Array.isArray(entry.items))?.items[0]).toMatchObject({
      externalId: 'meeting_1',
      kind: 'meeting',
      summary: '{"decisions":["Ship OAuth"],"actions":["Verify staging"]}',
    });
  });

  test('syncAllMcpConnections retries errored rows, skips disconnected rows, and totals item counts', async () => {
    const { syncAllMcpConnections } = await import('../lib/mcp/sync');

    const result = await syncAllMcpConnections(
      'user_1',
      depsFor({
        listUserConnections: async () =>
          [
            bitbucketRow,
            { ...bitbucketRow, connectionId: 'errored_conn', status: 'error' },
            { ...bitbucketRow, connectionId: 'disconnected_conn', status: 'disconnected' },
          ] as any,
        getConnectionToken: async (_userId, connectionId) => {
          expect(['bitbucket_conn', 'errored_conn']).toContain(connectionId);
          return {
            row: { ...bitbucketRow, connectionId } as any,
            token: 'person@example.com:api-token',
          };
        },
        loadBitbucketItems: async () => ({
          items: [
            {
              externalId: 'pr_1',
              kind: 'pull_request',
              title: 'One item',
              searchText: 'One item',
            },
          ],
        }),
      }),
    );

    expect(result).toEqual({ connections: 2, items: 2 });
  });
});
