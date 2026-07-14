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

  test('loads GitHub issues, projects, and commits through the direct read API', async () => {
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
            serverUrl: 'https://api.github.com',
            authKind: 'token',
            status: 'connected',
            scopes: [],
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
    expect(mutations.find((mutation) => Array.isArray(mutation.items))?.items[0]).toMatchObject({
      externalId: 'github:issue:lab86/mail#123',
      kind: 'issue',
      title: 'Investigate CI flakes',
      state: 'open',
      author: 'octocat',
    });
    expect(mutations.at(-1)).toMatchObject({ server: 'github', status: 'ready', itemCount: 3 });
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
