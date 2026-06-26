import { describe, expect, test } from 'bun:test';
import type { McpClientHandle } from '../lib/mcp/client';
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

  test('normalizes MCP tool output, upserts it, closes the client, and marks ready', async () => {
    const mutations: Array<Record<string, any>> = [];
    const calledTools: string[] = [];
    let closed = false;
    const handle: McpClientHandle = {
      client: {} as any,
      toolNames: new Set(['search_issues']),
      close: async () => {
        closed = true;
      },
    };
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
            scopes: [],
            includeInBrief: true,
            includeInSearch: true,
          } as any,
          token: 'ghp_123',
        }),
        connectMcp: async (serverUrl, token, authMode) => {
          expect(serverUrl).toContain('githubcopilot.com');
          expect(token).toBe('ghp_123');
          expect(authMode).toBe('bearer');
          return handle;
        },
        callMcpTool: async (_handle, tool) => {
          calledTools.push(tool);
          if (calledTools.length > 1) return { structuredContent: { items: [] } };
          return {
            structuredContent: {
              items: [
                {
                  id: 'issue_123',
                  title: 'Investigate CI flakes',
                  html_url: 'https://github.com/lab86/mail/issues/123',
                  state: 'open',
                  user: { login: 'octocat' },
                  updated_at: '2026-06-25T16:00:00.000Z',
                },
              ],
            },
          };
        },
        convexMutation: async (_fn, args) => {
          mutations.push(args);
          return undefined as any;
        },
      }),
    );

    expect(result).toEqual({ ok: true, count: 1 });
    expect(calledTools).toEqual(['search_issues', 'search_issues']);
    expect(closed).toBe(true);
    expect(mutations.find((mutation) => Array.isArray(mutation.items))?.items[0]).toMatchObject({
      externalId: 'issue_123',
      kind: 'issue',
      title: 'Investigate CI flakes',
      state: 'open',
      author: 'octocat',
    });
    expect(mutations.at(-1)).toMatchObject({ server: 'github', status: 'ready', itemCount: 1 });
  });

  test('syncAllMcpConnections only syncs connected rows and totals item counts', async () => {
    const { syncAllMcpConnections } = await import('../lib/mcp/sync');

    const result = await syncAllMcpConnections(
      'user_1',
      depsFor({
        listUserConnections: async () =>
          [
            bitbucketRow,
            { ...bitbucketRow, connectionId: 'disconnected_conn', status: 'disconnected' },
          ] as any,
        getConnectionToken: async (_userId, connectionId) => {
          expect(connectionId).toBe(bitbucketRow.connectionId);
          return { row: bitbucketRow as any, token: 'person@example.com:api-token' };
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

    expect(result).toEqual({ connections: 1, items: 1 });
  });
});
