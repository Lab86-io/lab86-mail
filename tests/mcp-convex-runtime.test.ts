import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api, internal } from '../convex/_generated/api';
import { contentAccess } from '../convex/content';
import schema from '../convex/schema';

const convexModules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/mcp.ts': () => import('../convex/mcp'),
};

const SECRET = 'mcp-runtime-secret';
const USER = 'mcp_runtime_user';
const CONNECTION = 'github:conn_1';
let previousSecret: string | undefined;

beforeAll(() => {
  previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});

afterAll(() => {
  if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
});

function newHarness() {
  return convexTest(schema, convexModules);
}

type Harness = ReturnType<typeof newHarness>;

async function connect(t: Harness, overrides: Record<string, unknown> = {}) {
  await t.mutation(api.mcp.upsertConnection, {
    internalSecret: SECRET,
    userId: USER,
    connectionId: CONNECTION,
    server: 'github' as const,
    serverUrl: 'https://api.githubcopilot.com/mcp/',
    authKind: 'token' as const,
    accessTokenEncrypted: 'enc:token',
    masked: 'ghp_****',
    ...overrides,
  });
}

function item(overrides: Record<string, unknown> = {}) {
  return {
    externalId: 'org/repo#1',
    kind: 'pull_request',
    title: 'Fix the flaky test',
    url: 'https://github.com/org/repo/pull/1',
    state: 'open',
    repository: 'org/repo',
    searchText: 'fix the flaky test org/repo pull request',
    ...overrides,
  };
}

async function upsert(t: Harness, items: Record<string, unknown>[]) {
  return t.mutation(api.mcp.upsertItems, {
    internalSecret: SECRET,
    userId: USER,
    connectionId: CONNECTION,
    server: 'github' as const,
    items: items as never,
  });
}

describe('connection lifecycle', () => {
  test('upsertConnection writes display row plus credentials and replaces both in place', async () => {
    const t = newHarness();
    await connect(t);
    await connect(t, { accessTokenEncrypted: 'enc:rotated', displayName: 'GitHub' });
    const rows = await t.query(api.mcp.listConnections, { internalSecret: SECRET, userId: USER });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      connectionId: CONNECTION,
      status: 'connected',
      displayName: 'GitHub',
      includeInBrief: true,
      includeInSearch: true,
    });
    const creds = await t.run((ctx) => ctx.db.query('mcpCredentials').collect());
    expect(creds).toHaveLength(1);
    expect(creds[0].accessTokenEncrypted).toBe('enc:rotated');

    const withCreds = await t.query(api.mcp.getConnectionWithCredentials, {
      internalSecret: SECRET,
      userId: USER,
      connectionId: CONNECTION,
    });
    expect(withCreds?.credentials?.accessTokenEncrypted).toBe('enc:rotated');
    expect(
      await t.query(api.mcp.getConnectionWithCredentials, {
        internalSecret: SECRET,
        userId: USER,
        connectionId: 'missing',
      }),
    ).toBeNull();
    await expect(t.query(api.mcp.listConnections, { internalSecret: 'bad', userId: USER })).rejects.toThrow(
      /Invalid Convex internal secret/,
    );
  });

  test('updateConnectionConfig only patches a matching server', async () => {
    const t = newHarness();
    await connect(t);
    expect(
      await t.mutation(api.mcp.updateConnectionConfig, {
        internalSecret: SECRET,
        userId: USER,
        connectionId: CONNECTION,
        server: 'jira' as const,
        serverUrl: 'https://other',
        scopes: ['read'],
      }),
    ).toEqual({ ok: false });
    expect(
      await t.mutation(api.mcp.updateConnectionConfig, {
        internalSecret: SECRET,
        userId: USER,
        connectionId: CONNECTION,
        server: 'github' as const,
        serverUrl: 'https://new-url/mcp/',
        scopes: ['repo'],
      }),
    ).toEqual({ ok: true });
    const row = await t.run((ctx) => ctx.db.query('mcpConnections').unique());
    expect(row).toMatchObject({ serverUrl: 'https://new-url/mcp/', scopes: ['repo'] });
  });

  test('setConnectionToggles flips brief/search inclusion and reports misses', async () => {
    const t = newHarness();
    await connect(t);
    expect(
      await t.mutation(api.mcp.setConnectionToggles, {
        internalSecret: SECRET,
        userId: USER,
        connectionId: 'missing',
        includeInBrief: false,
      }),
    ).toEqual({ ok: false });
    await t.mutation(api.mcp.setConnectionToggles, {
      internalSecret: SECRET,
      userId: USER,
      connectionId: CONNECTION,
      includeInBrief: false,
      includeInSearch: false,
    });
    const row = await t.run((ctx) => ctx.db.query('mcpConnections').unique());
    expect(row).toMatchObject({ includeInBrief: false, includeInSearch: false });
  });

  test('updateOAuthCredentials refuses token connections and refreshes oauth ones', async () => {
    const t = newHarness();
    await connect(t);
    expect(
      await t.mutation(api.mcp.updateOAuthCredentials, {
        internalSecret: SECRET,
        userId: USER,
        connectionId: CONNECTION,
        accessTokenEncrypted: 'enc:new',
        oauthClientInformationEncrypted: 'enc:client',
      }),
    ).toEqual({ ok: false });
    await connect(t, { authKind: 'oauth' as const });
    expect(
      await t.mutation(api.mcp.updateOAuthCredentials, {
        internalSecret: SECRET,
        userId: USER,
        connectionId: CONNECTION,
        accessTokenEncrypted: 'enc:new',
        refreshTokenEncrypted: 'enc:refresh',
        expiresAt: 12345,
        oauthClientInformationEncrypted: 'enc:client',
        scopes: ['repo', 'read:user'],
      }),
    ).toEqual({ ok: true });
    const creds = await t.run((ctx) => ctx.db.query('mcpCredentials').unique());
    expect(creds).toMatchObject({
      accessTokenEncrypted: 'enc:new',
      refreshTokenEncrypted: 'enc:refresh',
      expiresAt: 12345,
    });
    const connection = await t.run((ctx) => ctx.db.query('mcpConnections').unique());
    expect(connection?.scopes).toEqual(['repo', 'read:user']);
  });
});

describe('oauth state store', () => {
  test('consumeOAuthStateFromCallback is single-use and expiry-aware', async () => {
    const t = newHarness();
    const save = (state: string, expiresAt: number) =>
      t.mutation(api.mcp.saveOAuthState, {
        internalSecret: SECRET,
        userId: USER,
        state,
        server: 'github' as const,
        payloadEncrypted: `enc:${state}`,
        expiresAt,
      });
    await save('state_live', Date.now() + 60_000);
    await save('state_dead', Date.now() - 1);
    const consume = (state: string) =>
      t.mutation(api.mcp.consumeOAuthStateFromCallback, { internalSecret: SECRET, state });

    await expect(
      t.mutation(api.mcp.consumeOAuthStateFromCallback, { internalSecret: 'wrong', state: 'state_live' }),
    ).rejects.toThrow();
    expect(await consume('state_live')).toEqual({
      userId: USER,
      server: 'github',
      payloadEncrypted: 'enc:state_live',
      nativeCallback: false,
    });
    // Single use.
    expect(await consume('state_live')).toBeNull();
    // Expired states delete on consumption and return nothing.
    expect(await consume('state_dead')).toBeNull();
    expect(await t.run((ctx) => ctx.db.query('mcpOAuthStates').collect())).toHaveLength(0);
  });

  test('saveOAuthState replaces an existing state row and the sweeper drops expired ones', async () => {
    const t = newHarness();
    for (const payload of ['first', 'second']) {
      await t.mutation(api.mcp.saveOAuthState, {
        internalSecret: SECRET,
        userId: USER,
        state: 'state_dup',
        server: 'github' as const,
        payloadEncrypted: `enc:${payload}`,
        expiresAt: Date.now() - 1,
      });
    }
    expect(await t.run((ctx) => ctx.db.query('mcpOAuthStates').collect())).toHaveLength(1);
    const swept = await t.mutation(internal.mcp.sweepExpiredOAuthStates, {});
    expect(swept).toEqual({ deleted: 1 });
    expect(await t.run((ctx) => ctx.db.query('mcpOAuthStates').collect())).toHaveLength(0);
  });
});

describe('sync state', () => {
  test('setSyncState upserts and mirrors the sync result onto the connection row', async () => {
    const t = newHarness();
    await connect(t);
    await t.mutation(api.mcp.setSyncState, {
      internalSecret: SECRET,
      userId: USER,
      connectionId: CONNECTION,
      server: 'github',
      status: 'error',
      error: 'rate limited',
    });
    let connection = await t.run((ctx) => ctx.db.query('mcpConnections').unique());
    // A failed sync with no sign-in failure keeps the connection state.
    expect(connection).toMatchObject({ status: 'connected', lastSyncError: 'rate limited' });
    expect(connection?.error).toBeUndefined();

    await t.mutation(api.mcp.setSyncState, {
      internalSecret: SECRET,
      userId: USER,
      connectionId: CONNECTION,
      server: 'github',
      status: 'ready',
      lastSyncedAt: 777,
      itemCount: 3,
      accountEmail: 'me@example.com',
    });
    connection = await t.run((ctx) => ctx.db.query('mcpConnections').unique());
    expect(connection).toMatchObject({ status: 'connected', lastSyncedAt: 777 });
    expect(connection?.lastSyncError).toBeUndefined();
    expect(connection?.lastSyncErrorAt).toBeUndefined();
    expect(typeof connection?.lastSyncOkAt).toBe('number');
    const [listed] = await t.query(api.mcp.listConnections, { internalSecret: SECRET, userId: USER });
    expect(listed).toMatchObject({ syncStatus: 'ready', itemCount: 3, accountEmail: 'me@example.com' });
    const states = await t.run((ctx) => ctx.db.query('mcpSyncStates').collect());
    expect(states).toHaveLength(1);
  });

  test('listSyncTargetUserIds dedupes and retries errored connections but not disconnected ones', async () => {
    const t = newHarness();
    await connect(t);
    await connect(t, { connectionId: 'jira:conn_2', server: 'jira' as const });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query('mcpConnections')
        .withIndex('by_user_connection', (q) => q.eq('userId', USER).eq('connectionId', 'jira:conn_2'))
        .unique();
      await ctx.db.patch(row!._id, { status: 'error' });
      const ts = Date.now();
      await ctx.db.insert('mcpConnections', {
        userId: 'gone_user',
        connectionId: 'github:gone',
        server: 'github',
        serverUrl: 'https://x',
        authKind: 'token',
        status: 'disconnected',
        scopes: [],
        includeInBrief: true,
        includeInSearch: true,
        createdAt: ts,
        updatedAt: ts,
      });
    });
    expect(await t.query(internal.mcp.listSyncTargetUserIds, {})).toEqual([USER]);
  });
});

describe('item ingest', () => {
  test('upsertItems dedupes per external id and records evidence rows', async () => {
    const t = newHarness();
    await connect(t);
    expect(await upsert(t, [item()])).toEqual({ ok: true, count: 1 });
    await upsert(t, [item({ title: 'Fix the flaky test v2' })]);
    const items = await t.run((ctx) => ctx.db.query('mcpItems').collect());
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Fix the flaky test v2');
    const evidence = await t.run((ctx) => ctx.db.query('albatrossEvidence').collect());
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      dedupeKey: `mcp:github:${CONNECTION}:org/repo#1`,
      trust: 'observed',
    });
  });

  test('matching an active area creates a candidate area link once', async () => {
    const t = newHarness();
    await connect(t);
    await t.run(async (ctx) => {
      const ts = Date.now();
      await ctx.db.insert('areas', {
        userId: USER,
        name: 'Treecaching',
        kind: 'project',
        status: 'active',
        primaryDomain: 'treecaching.com',
        createdAt: ts,
        updatedAt: ts,
      });
    });
    await upsert(t, [
      item({
        externalId: 'org/treecaching#7',
        title: 'Treecaching cache invalidation',
        repository: 'org/treecaching',
        searchText: 'treecaching cache invalidation org/treecaching',
      }),
    ]);
    let links = await t.run((ctx) => ctx.db.query('areaArtifactLinks').collect());
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ artifactKind: 'mcpItem', status: 'candidate', role: 'supporting' });
    // Re-syncing the same item does not duplicate the link.
    await upsert(t, [
      item({
        externalId: 'org/treecaching#7',
        title: 'Treecaching cache invalidation',
        repository: 'org/treecaching',
        searchText: 'treecaching cache invalidation org/treecaching',
      }),
    ]);
    links = await t.run((ctx) => ctx.db.query('areaArtifactLinks').collect());
    expect(links).toHaveLength(1);
  });

  test('a transition into a terminal state completes linked cards exactly once', async () => {
    const t = newHarness();
    await connect(t);
    const cardId = await t.run(async (ctx) => {
      const ts = Date.now();
      const boardId = await ctx.db.insert('boards', {
        ownerUserId: USER,
        title: 'Work',
        createdAt: ts,
        updatedAt: ts,
      });
      const columnId = await ctx.db.insert('boardColumns', {
        boardId,
        name: 'Doing',
        order: 0,
        createdAt: ts,
        updatedAt: ts,
      });
      return ctx.db.insert('cards', {
        boardId,
        columnId,
        userId: USER,
        title: 'Land the PR',
        order: 0,
        createdAt: ts,
        updatedAt: ts,
      });
    });
    await upsert(t, [item({ state: 'open' })]);
    await t.mutation(api.mcp.linkTask, {
      internalSecret: SECRET,
      userId: USER,
      connectionId: CONNECTION,
      server: 'github',
      externalId: 'org/repo#1',
      cardId: String(cardId),
    });
    // Duplicate link requests are no-ops.
    await t.mutation(api.mcp.linkTask, {
      internalSecret: SECRET,
      userId: USER,
      connectionId: CONNECTION,
      server: 'github',
      externalId: 'org/repo#1',
      cardId: String(cardId),
    });
    expect(await t.run((ctx) => ctx.db.query('mcpTaskLinks').collect())).toHaveLength(1);

    await upsert(t, [item({ state: 'merged' })]);
    const card = await t.run((ctx) => ctx.db.get(cardId));
    expect(card?.completedAt).toBeGreaterThan(0);
    const link = await t.run((ctx) => ctx.db.query('mcpTaskLinks').unique());
    expect(link?.lastSyncedState).toBe('merged');

    // Reopen the card, then sync merged again: already-terminal, so no clobber.
    await t.run((ctx) => ctx.db.patch(cardId, { completedAt: undefined }));
    await upsert(t, [item({ state: 'merged', title: 'Still merged' })]);
    expect((await t.run((ctx) => ctx.db.get(cardId)))?.completedAt).toBeUndefined();
  });

  test("linkTask refuses cards that are not the caller's", async () => {
    const t = newHarness();
    await connect(t);
    const foreignCard = await t.run(async (ctx) => {
      const ts = Date.now();
      const boardId = await ctx.db.insert('boards', {
        ownerUserId: 'other',
        title: 'Theirs',
        createdAt: ts,
        updatedAt: ts,
      });
      const columnId = await ctx.db.insert('boardColumns', {
        boardId,
        name: 'Todo',
        order: 0,
        createdAt: ts,
        updatedAt: ts,
      });
      return ctx.db.insert('cards', {
        boardId,
        columnId,
        userId: 'other',
        title: 'Not yours',
        order: 0,
        createdAt: ts,
        updatedAt: ts,
      });
    });
    await expect(
      t.mutation(api.mcp.linkTask, {
        internalSecret: SECRET,
        userId: USER,
        connectionId: CONNECTION,
        server: 'github',
        externalId: 'org/repo#1',
        cardId: String(foreignCard),
      }),
    ).rejects.toThrow(/does not belong to you/);
  });
});

describe('item reads', () => {
  test('listItemsForBrief honors the includeInBrief toggle and server filter', async () => {
    const t = newHarness();
    await connect(t);
    await upsert(t, [
      item({ updatedAtSource: 2_000 }),
      item({ externalId: 'org/repo#2', title: 'Second', updatedAtSource: 3_000 }),
    ]);
    let rows = await t.query(api.mcp.listItemsForBrief, { internalSecret: SECRET, userId: USER });
    expect(rows.map((r) => r.externalId)).toEqual(['org/repo#2', 'org/repo#1']);
    rows = await t.query(api.mcp.listItemsForBrief, { internalSecret: SECRET, userId: USER, server: 'jira' });
    expect(rows).toEqual([]);
    await t.mutation(api.mcp.setConnectionToggles, {
      internalSecret: SECRET,
      userId: USER,
      connectionId: CONNECTION,
      includeInBrief: false,
    });
    rows = await t.query(api.mcp.listItemsForBrief, { internalSecret: SECRET, userId: USER });
    expect(rows).toEqual([]);
  });

  test('searchItems only surfaces search-enabled connections and requires a query', async () => {
    const t = newHarness();
    await connect(t);
    await upsert(t, [item()]);
    let rows = await t.query(api.mcp.searchItems, { internalSecret: SECRET, userId: USER, query: 'flaky' });
    expect(rows.map((r) => r.externalId)).toEqual(['org/repo#1']);
    rows = await t.query(api.mcp.searchItems, {
      internalSecret: SECRET,
      userId: USER,
      query: 'flaky',
      repository: 'org/other',
    });
    expect(rows).toEqual([]);
    expect(
      await t.query(api.mcp.searchItems, { internalSecret: SECRET, userId: USER, query: '   ' }),
    ).toEqual([]);
    await t.mutation(api.mcp.setConnectionToggles, {
      internalSecret: SECRET,
      userId: USER,
      connectionId: CONNECTION,
      includeInSearch: false,
    });
    expect(
      await t.query(api.mcp.searchItems, { internalSecret: SECRET, userId: USER, query: 'flaky' }),
    ).toEqual([]);
  });
});

describe('connector sync errors', () => {
  test('a sync error keeps indexed items in search and the Brief', async () => {
    const t = newHarness();
    await connect(t);
    await upsert(t, [item()]);
    await t.mutation(api.mcp.setSyncState, {
      internalSecret: SECRET,
      userId: USER,
      connectionId: CONNECTION,
      server: 'github',
      status: 'error',
      error: 'account check: rate limited',
    });
    const connections = await t.query(api.mcp.listConnections, { internalSecret: SECRET, userId: USER });
    expect(connections[0]).toMatchObject({
      status: 'connected',
      lastSyncError: 'account check: rate limited',
      syncError: 'account check: rate limited',
    });
    const found = await t.query(api.mcp.searchItems, {
      internalSecret: SECRET,
      userId: USER,
      query: 'flaky',
    });
    expect(found.map((r) => r.externalId)).toEqual(['org/repo#1']);
    const brief = await t.query(api.mcp.listItemsForBrief, { internalSecret: SECRET, userId: USER });
    expect(brief.map((r) => r.externalId)).toEqual(['org/repo#1']);
  });

  test('indexed connector content stays readable through a sync error, not a disconnect', async () => {
    const t = newHarness();
    await connect(t);
    await upsert(t, [item()]);
    const content = { userId: USER, source: 'github', connectionId: CONNECTION, externalId: 'org/repo#1' };
    const setStatus = (status: 'connected' | 'error' | 'disconnected') =>
      t.run(async (ctx) => {
        const row = await ctx.db
          .query('mcpConnections')
          .withIndex('by_user_connection', (q) => q.eq('userId', USER).eq('connectionId', CONNECTION))
          .unique();
        await ctx.db.patch(row!._id, { status });
      });
    await setStatus('error');
    expect(await t.run((ctx) => contentAccess(ctx, USER, content))).toBe(true);
    await setStatus('disconnected');
    expect(await t.run((ctx) => contentAccess(ctx, USER, content))).toBe(false);
  });
});

describe('connection health (AI-7)', () => {
  const syncResult = (t: Harness, args: Record<string, unknown>) =>
    t.mutation(api.mcp.setSyncState, {
      internalSecret: SECRET,
      userId: USER,
      connectionId: CONNECTION,
      server: 'github',
      ...args,
    } as any);
  const row = (t: Harness) => t.run((ctx) => ctx.db.query('mcpConnections').unique());

  test('a partial sync failure keeps the connection connected and records the error', async () => {
    const t = newHarness();
    await connect(t);
    await syncResult(t, { status: 'syncing' });
    expect(await row(t)).toMatchObject({ status: 'connected' });
    await syncResult(t, {
      status: 'error',
      outcome: 'ok',
      error: 'account check: rate limited',
      lastSyncedAt: 900,
      itemCount: 4,
    });
    const connection = await row(t);
    expect(connection).toMatchObject({
      status: 'connected',
      lastSyncedAt: 900,
      lastSyncError: 'account check: rate limited',
    });
    expect(connection?.error).toBeUndefined();
    // The same run saved items, so the problem reads as partial.
    expect(connection?.lastSyncOkAt).toBe(connection?.lastSyncErrorAt);
    const [listed] = await t.query(api.mcp.listConnections, { internalSecret: SECRET, userId: USER });
    expect(listed).toMatchObject({ status: 'connected', syncStatus: 'error', itemCount: 4 });
  });

  test('a failed sign-in needs a reconnect, and the next good sync heals it', async () => {
    const t = newHarness();
    await connect(t);
    await syncResult(t, {
      status: 'error',
      outcome: 'reconnect',
      error: 'auth rejected — reconnect with a valid token',
    });
    expect(await row(t)).toMatchObject({
      status: 'error',
      error: 'auth rejected — reconnect with a valid token',
      lastSyncError: 'auth rejected — reconnect with a valid token',
    });
    // A later failure that says nothing about the sign-in keeps the reconnect state.
    await syncResult(t, { status: 'error', error: 'socket hang up' });
    expect(await row(t)).toMatchObject({
      status: 'error',
      error: 'auth rejected — reconnect with a valid token',
      lastSyncError: 'socket hang up',
    });
    await syncResult(t, { status: 'ready', outcome: 'ok', lastSyncedAt: 1000, itemCount: 1 });
    const healed = await row(t);
    expect(healed).toMatchObject({ status: 'connected', lastSyncedAt: 1000 });
    expect(healed?.error).toBeUndefined();
    expect(healed?.lastSyncError).toBeUndefined();
  });

  test('a new sign-in on the same connection clears the reconnect reason and the sync problem', async () => {
    const t = newHarness();
    await connect(t);
    await syncResult(t, { status: 'error', outcome: 'reconnect', error: 'Reconnect GitHub: expired.' });
    await connect(t, { accessTokenEncrypted: 'enc:new-token' });
    const connection = await row(t);
    expect(connection).toMatchObject({ status: 'connected' });
    expect(connection?.error).toBeUndefined();
    expect(connection?.lastSyncError).toBeUndefined();
    expect(connection?.lastSyncErrorAt).toBeUndefined();
  });

  test('a sync that finishes after a disconnect does not bring the connection back', async () => {
    const t = newHarness();
    await connect(t);
    await t.mutation(api.mcp.disconnectConnection, {
      internalSecret: SECRET,
      userId: USER,
      connectionId: CONNECTION,
    });
    await syncResult(t, { status: 'ready', outcome: 'ok', lastSyncedAt: 5, itemCount: 0 });
    expect(await row(t)).toMatchObject({ status: 'disconnected' });
  });
});

describe('repairSyncErrorStatus migration (AI-7)', () => {
  async function seed(t: Harness) {
    await t.run(async (ctx) => {
      const base = {
        userId: USER,
        server: 'github' as const,
        serverUrl: 'https://api.github.com',
        authKind: 'token' as const,
        scopes: [],
        includeInBrief: true,
        includeInSearch: true,
        createdAt: 1,
      };
      const credential = (connectionId: string, extra: Record<string, unknown> = {}) =>
        ctx.db.insert('mcpCredentials', {
          userId: USER,
          connectionId,
          server: 'github',
          accessTokenEncrypted: 'enc:token',
          createdAt: 1,
          updatedAt: 1,
          ...extra,
        });
      // A past partial failure with a good token: back to connected.
      await ctx.db.insert('mcpConnections', {
        ...base,
        connectionId: 'partial',
        status: 'error',
        error: 'account check: rate limited',
        updatedAt: 500,
      });
      await credential('partial');
      // A real sign-in failure: keeps the reconnect state.
      await ctx.db.insert('mcpConnections', {
        ...base,
        connectionId: 'auth',
        status: 'error',
        error: 'auth rejected — reconnect with a valid token',
        updatedAt: 600,
      });
      await credential('auth');
      // No credentials: keeps the reconnect state.
      await ctx.db.insert('mcpConnections', {
        ...base,
        connectionId: 'nocreds',
        status: 'error',
        error: 'socket hang up',
        updatedAt: 700,
      });
      // An expired OAuth sign-in with no refresh token: keeps the reconnect state.
      await ctx.db.insert('mcpConnections', {
        ...base,
        connectionId: 'expired',
        server: 'granola',
        authKind: 'oauth',
        status: 'error',
        error: 'socket hang up',
        updatedAt: 800,
      });
      await credential('expired', { expiresAt: 10 });
      // A healthy row is not touched.
      await ctx.db.insert('mcpConnections', {
        ...base,
        connectionId: 'healthy',
        status: 'connected',
        updatedAt: 900,
      });
      await credential('healthy');
    });
  }
  const byId = async (t: Harness) =>
    Object.fromEntries(
      (await t.run((ctx) => ctx.db.query('mcpConnections').collect())).map((r) => [r.connectionId, r]),
    );

  test('moves past partial failures back to connected and keeps real reconnects, idempotently', async () => {
    const t = newHarness();
    await seed(t);

    const dry = await t.mutation(internal.mcp.repairSyncErrorStatus, { dryRun: true });
    expect(dry).toMatchObject({ scanned: 4, repaired: 1, kept: 3, dryRun: true, isDone: true });
    expect((await byId(t)).partial.status).toBe('error');

    const first = await t.mutation(internal.mcp.repairSyncErrorStatus, {});
    expect(first).toMatchObject({ scanned: 4, repaired: 1, kept: 3, isDone: true });
    const rows = await byId(t);
    expect(rows.partial).toMatchObject({
      status: 'connected',
      lastSyncError: 'account check: rate limited',
      lastSyncErrorAt: 500,
    });
    expect(rows.partial.error).toBeUndefined();
    expect(rows.auth).toMatchObject({
      status: 'error',
      error: 'auth rejected — reconnect with a valid token',
    });
    expect(rows.nocreds.status).toBe('error');
    expect(rows.expired.status).toBe('error');
    expect(rows.healthy).toMatchObject({ status: 'connected', updatedAt: 900 });

    const second = await t.mutation(internal.mcp.repairSyncErrorStatus, {});
    expect(second).toMatchObject({ scanned: 3, repaired: 0, kept: 3 });
  });

  test('pages through the rows and schedules each next page', async () => {
    const t = newHarness();
    await seed(t);
    const first = await t.mutation(internal.mcp.repairSyncErrorStatus, { batchSize: 1 });
    expect(first).toMatchObject({ scanned: 1, isDone: false });
    expect(typeof first.continueCursor).toBe('string');
    await t.finishAllScheduledFunctions(() => {});
    const rows = await byId(t);
    expect(rows.partial.status).toBe('connected');
    expect(['auth', 'nocreds', 'expired'].map((id) => rows[id].status)).toEqual(['error', 'error', 'error']);
  });
});

describe('disconnect flow', () => {
  test('disconnectConnection wipes credentials, schedules cleanup, and the sweeper re-schedules stragglers', async () => {
    const t = newHarness();
    await connect(t);
    await upsert(t, [item()]);
    const result = await t.mutation(api.mcp.disconnectConnection, {
      internalSecret: SECRET,
      userId: USER,
      connectionId: CONNECTION,
    });
    expect(result).toEqual({ ok: true, cleanupScheduled: true });
    expect(await t.run((ctx) => ctx.db.query('mcpCredentials').collect())).toHaveLength(0);
    expect(
      await t.mutation(api.mcp.disconnectConnection, {
        internalSecret: SECRET,
        userId: USER,
        connectionId: 'missing',
      }),
    ).toEqual({ ok: true, cleanupScheduled: false });

    const swept = await t.mutation(internal.mcp.sweepDisconnectedConnections, {});
    expect(swept).toEqual({ scheduled: 1 });

    // Drive cleanup to completion directly (phases: evidence -> items -> rows).
    let out = await t.mutation(internal.mcp.cleanupDisconnectedConnection, {
      userId: USER,
      connectionId: CONNECTION,
    });
    expect(out).toMatchObject({ ok: true, remaining: true, phase: 'evidence' });
    out = await t.mutation(internal.mcp.cleanupDisconnectedConnection, {
      userId: USER,
      connectionId: CONNECTION,
    });
    expect(out).toMatchObject({ ok: true, remaining: true, phase: 'items' });
    out = await t.mutation(internal.mcp.cleanupDisconnectedConnection, {
      userId: USER,
      connectionId: CONNECTION,
    });
    expect(out).toEqual({ ok: true, remaining: false });
    expect(await t.run((ctx) => ctx.db.query('mcpConnections').collect())).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query('mcpItems').collect())).toHaveLength(0);
  });

  test('cleanup refuses to run against a connection that is still active', async () => {
    const t = newHarness();
    await connect(t);
    expect(
      await t.mutation(internal.mcp.cleanupDisconnectedConnection, {
        userId: USER,
        connectionId: CONNECTION,
      }),
    ).toEqual({ ok: false, reason: 'active' });
  });

  test('cleanup detaches task links into a preserved source chip on owned cards', async () => {
    const t = newHarness();
    await connect(t);
    await upsert(t, [item()]);
    const cardId = await t.run(async (ctx) => {
      const ts = Date.now();
      const boardId = await ctx.db.insert('boards', {
        ownerUserId: USER,
        title: 'Work',
        createdAt: ts,
        updatedAt: ts,
      });
      const columnId = await ctx.db.insert('boardColumns', {
        boardId,
        name: 'Doing',
        order: 0,
        createdAt: ts,
        updatedAt: ts,
      });
      return ctx.db.insert('cards', {
        boardId,
        columnId,
        userId: USER,
        title: 'Land the PR',
        order: 0,
        source: { kind: 'mcp', connectionId: CONNECTION, externalId: 'org/repo#1' },
        createdAt: ts,
        updatedAt: ts,
      });
    });
    await t.mutation(api.mcp.linkTask, {
      internalSecret: SECRET,
      userId: USER,
      connectionId: CONNECTION,
      server: 'github',
      externalId: 'org/repo#1',
      cardId: String(cardId),
    });
    await t.mutation(api.mcp.disconnectConnection, {
      internalSecret: SECRET,
      userId: USER,
      connectionId: CONNECTION,
    });
    const out = await t.mutation(internal.mcp.cleanupDisconnectedConnection, {
      userId: USER,
      connectionId: CONNECTION,
    });
    expect(out).toMatchObject({ ok: true, remaining: true, phase: 'taskLinks' });
    expect(await t.run((ctx) => ctx.db.query('mcpTaskLinks').collect())).toHaveLength(0);
    const card = await t.run((ctx) => ctx.db.get(cardId));
    expect(card?.source).toBeTruthy();
    expect(JSON.stringify(card?.source)).toContain('Fix the flaky test');
  });
});
