import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api, internal } from '../convex/_generated/api';
import { MCP_ITEM_STALE_MS, MCP_PRUNE_BATCH, mcpConnectionWantsSync, mcpPruneCutoff } from '../convex/mcp';
import schema from '../convex/schema';

const convexModules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/mcp.ts': () => import('../convex/mcp'),
};

const SECRET = 'mcp-io-sync-secret';
const USER = 'mcp_io_user';
const CONNECTION = 'github:conn_io';
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 1, 12);
let previousSecret: string | undefined;

beforeAll(() => {
  previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});

afterAll(() => {
  if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
});

afterEach(() => setSystemTime());

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
    serverUrl: 'https://api.github.com',
    authKind: 'token' as const,
    accessTokenEncrypted: 'enc:token',
    ...overrides,
  });
}

function item(overrides: Record<string, unknown> = {}) {
  return {
    externalId: 'github:pull_request:org/treecaching#1',
    kind: 'pull_request',
    title: 'Treecaching cache invalidation',
    state: 'open',
    repository: 'org/treecaching',
    searchText: 'treecaching cache invalidation org/treecaching',
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

async function addArea(t: Harness, name = 'Treecaching') {
  return t.run(async (ctx) => {
    const ts = Date.now();
    return ctx.db.insert('areas', {
      userId: USER,
      name,
      kind: 'project',
      status: 'active',
      primaryDomain: 'treecaching.com',
      createdAt: ts,
      updatedAt: ts,
    });
  });
}

const rows = (t: Harness) =>
  t.run(async (ctx) => ({
    items: await ctx.db.query('mcpItems').collect(),
    evidence: await ctx.db.query('albatrossEvidence').collect(),
    links: await ctx.db.query('areaArtifactLinks').collect(),
  }));

describe('MCP hash skip', () => {
  test('an unchanged item writes nothing, and a changed item writes once', async () => {
    const t = newHarness();
    setSystemTime(new Date(T0));
    await connect(t);
    await addArea(t);
    expect(await upsert(t, [item()])).toMatchObject({ count: 1, skipped: 0 });
    const first = await rows(t);
    expect(first.items[0]).toMatchObject({ lastSeenAt: T0, updatedAt: T0 });
    expect(first.items[0].syncHash).toBeString();
    expect(first.links).toHaveLength(1);

    setSystemTime(new Date(T0 + 20 * 60_000));
    expect(await upsert(t, [item()])).toMatchObject({ skipped: 1 });
    const second = await rows(t);
    expect(second.items[0]).toEqual(first.items[0]);
    expect(second.evidence[0]).toEqual(first.evidence[0]);
    expect(second.links).toEqual(first.links);

    setSystemTime(new Date(T0 + 40 * 60_000));
    expect(await upsert(t, [item({ state: 'closed' })])).toMatchObject({ skipped: 0 });
    const third = await rows(t);
    expect(third.items[0]).toMatchObject({ state: 'closed', updatedAt: T0 + 40 * 60_000 });
    expect(third.evidence[0].metadata.state).toBe('closed');
    expect(third.links).toHaveLength(1);
  });

  test('an unchanged item moves lastSeenAt at most once a day', async () => {
    const t = newHarness();
    setSystemTime(new Date(T0));
    await connect(t);
    await upsert(t, [item()]);
    setSystemTime(new Date(T0 + DAY - 1));
    await upsert(t, [item()]);
    expect((await rows(t)).items[0].lastSeenAt).toBe(T0);
    setSystemTime(new Date(T0 + DAY + 1));
    await upsert(t, [item()]);
    const [row] = (await rows(t)).items;
    expect(row.lastSeenAt).toBe(T0 + DAY + 1);
    expect(row.updatedAt).toBe(T0);
  });

  test('a changed area set matches the item again without a content update', async () => {
    const t = newHarness();
    setSystemTime(new Date(T0));
    await connect(t);
    await upsert(t, [item()]);
    expect((await rows(t)).links).toHaveLength(0);
    await addArea(t);
    setSystemTime(new Date(T0 + 60_000));
    expect(await upsert(t, [item()])).toMatchObject({ skipped: 0 });
    const after = await rows(t);
    expect(after.links).toHaveLength(1);
    // The item content did not change, so the content index keeps its place.
    expect(after.items[0].updatedAt).toBe(T0);
    expect(after.items[0].lastSeenAt).toBe(T0 + 60_000);
  });

  test('a row from before the hash field gets the hash on its next sync', async () => {
    const t = newHarness();
    await connect(t);
    await t.run(async (ctx) => {
      await ctx.db.insert('mcpItems', {
        userId: USER,
        connectionId: CONNECTION,
        server: 'github',
        ...item(),
        createdAt: T0 - DAY,
        updatedAt: T0 - DAY,
      });
    });
    setSystemTime(new Date(T0));
    expect(await upsert(t, [item()])).toMatchObject({ skipped: 0 });
    const [row] = (await rows(t)).items;
    expect(row.syncHash).toBeString();
    expect(row.lastSeenAt).toBe(T0);
    expect(row.updatedAt).toBe(T0 - DAY);
  });
});

describe('MCP prune', () => {
  // The prune counts "not seen" from the last clean sync of the connection.
  async function patchConnection(t: Harness, fields: Record<string, unknown>, connectionId = CONNECTION) {
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query('mcpConnections')
        .withIndex('by_user_connection', (q) => q.eq('userId', USER).eq('connectionId', connectionId))
        .unique();
      await ctx.db.patch(row!._id, fields as never);
    });
  }

  async function seedItem(t: Harness, externalId: string, fields: Record<string, unknown>) {
    return t.run(async (ctx) => {
      const id = await ctx.db.insert('mcpItems', {
        userId: USER,
        connectionId: CONNECTION,
        server: 'github',
        ...item({ externalId }),
        createdAt: T0 - 60 * DAY,
        updatedAt: T0 - 60 * DAY,
        ...fields,
      });
      await ctx.db.insert('albatrossEvidence', {
        userId: USER,
        sourceKind: 'github_pull_request',
        sourceId: externalId,
        connectionId: CONNECTION,
        title: 'x',
        occurredAt: T0,
        weight: 1,
        confidence: 1,
        trust: 'observed',
        dedupeKey: `mcp:github:${CONNECTION}:${externalId}`,
        searchText: 'x',
        createdAt: T0,
        updatedAt: T0,
      } as never);
      const content = await ctx.db.insert('contentItems', {
        userId: USER,
        key: `github:${CONNECTION}:${externalId}`,
        connectionId: CONNECTION,
        source: 'github',
        externalId,
        title: 'x',
        text: 'x',
        version: 'v',
        modifiedAt: T0,
        indexedAt: T0,
        partial: false,
        deleted: false,
        status: 'ready',
        attempts: 0,
        nextAttemptAt: 0,
      });
      await ctx.db.insert('contentChunks', {
        userId: USER,
        itemId: content,
        version: 'v',
        text: 'x',
        embedding: new Array(1536).fill(0),
      });
      return id;
    });
  }

  test('deletes stale items with their rows, keeps linked, fresh, and decided rows', async () => {
    const t = newHarness();
    await connect(t);
    await patchConnection(t, { lastSyncOkAt: T0 });
    const cutoffAge = MCP_ITEM_STALE_MS + DAY;
    await seedItem(t, 'stale', { lastSeenAt: T0 - cutoffAge });
    await seedItem(t, 'legacy-stale', {});
    await seedItem(t, 'legacy-fresh', { updatedAt: T0 - DAY });
    await seedItem(t, 'linked', { lastSeenAt: T0 - cutoffAge });
    await seedItem(t, 'fresh', { lastSeenAt: T0 - DAY });
    await t.run(async (ctx) => {
      await ctx.db.insert('mcpTaskLinks', {
        userId: USER,
        connectionId: CONNECTION,
        server: 'github',
        externalId: 'linked',
        cardId: 'card_1',
        createdAt: T0,
        updatedAt: T0,
      });
      const areaId = await ctx.db.insert('areas', {
        userId: USER,
        name: 'A',
        kind: 'project',
        status: 'active',
        createdAt: T0,
        updatedAt: T0,
      });
      for (const status of ['candidate', 'verified'] as const) {
        await ctx.db.insert('areaArtifactLinks', {
          userId: USER,
          areaId,
          externalId: 'stale',
          artifactKind: 'mcpItem',
          artifactId: `${CONNECTION}:stale`,
          accountId: CONNECTION,
          role: 'supporting',
          status,
          confidence: 0.5,
          reason: 'x',
          sourceRefs: [],
          confirmationRefs: [],
          createdAt: T0,
          updatedAt: T0,
        } as never);
      }
    });

    const dry = await t.mutation(internal.mcp.pruneStaleItems, {
      connectionId: CONNECTION,
      now: T0,
      dryRun: true,
    });
    expect(dry).toMatchObject({ deleted: 2, kept: 1, dated: 1, dryRun: true });
    expect((await rows(t)).items).toHaveLength(5);

    const result = await t.mutation(internal.mcp.pruneStaleItems, { connectionId: CONNECTION, now: T0 });
    expect(result).toMatchObject({ deleted: 2, kept: 1, dated: 1, more: false });
    const after = await t.run(async (ctx) => ({
      items: await ctx.db.query('mcpItems').collect(),
      evidence: await ctx.db.query('albatrossEvidence').collect(),
      links: await ctx.db.query('areaArtifactLinks').collect(),
      content: await ctx.db.query('contentItems').collect(),
      chunks: await ctx.db.query('contentChunks').collect(),
    }));
    expect(after.items.map((row) => row.externalId).sort()).toEqual(['fresh', 'legacy-fresh', 'linked']);
    expect(after.items.find((row) => row.externalId === 'linked')?.lastSeenAt).toBe(T0);
    expect(after.items.find((row) => row.externalId === 'legacy-fresh')?.lastSeenAt).toBe(T0 - DAY);
    expect(after.evidence.map((row) => row.sourceId).sort()).toEqual(['fresh', 'legacy-fresh', 'linked']);
    expect(after.links.map((row) => row.status)).toEqual(['verified']);
    expect(after.content).toHaveLength(3);
    expect(after.chunks).toHaveLength(3);
  });

  test('a full page schedules the next page, and the tick skips disconnected rows', async () => {
    const t = newHarness();
    await connect(t);
    await connect(t, { connectionId: 'github:gone' });
    await t.run(async (ctx) => {
      const gone = await ctx.db
        .query('mcpConnections')
        .withIndex('by_user_connection', (q) => q.eq('userId', USER).eq('connectionId', 'github:gone'))
        .unique();
      await ctx.db.patch(gone!._id, { status: 'disconnected' });
      for (let index = 0; index < MCP_PRUNE_BATCH + 3; index += 1) {
        await ctx.db.insert('mcpItems', {
          userId: USER,
          connectionId: CONNECTION,
          server: 'github',
          ...item({ externalId: `old-${index}` }),
          lastSeenAt: T0 - MCP_ITEM_STALE_MS - DAY,
          createdAt: T0,
          updatedAt: T0,
        });
      }
    });
    await patchConnection(t, { lastSyncOkAt: T0 });
    await patchConnection(t, { lastSyncOkAt: T0 }, 'github:gone');
    const first = await t.mutation(internal.mcp.pruneStaleItems, { connectionId: CONNECTION, now: T0 });
    expect(first).toMatchObject({ deleted: MCP_PRUNE_BATCH, more: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await t.finishAllScheduledFunctions(() => undefined);
    expect((await rows(t)).items).toHaveLength(0);
    expect(await t.mutation(internal.mcp.pruneStaleItemsTick, {})).toEqual({ scheduled: 1 });
  });

  test('a paused connection, or one whose last sync failed, keeps its items', async () => {
    const t = newHarness();
    await connect(t);
    await seedItem(t, 'old', { lastSeenAt: T0 - MCP_ITEM_STALE_MS - 30 * DAY });
    const prune = () => t.mutation(internal.mcp.pruneStaleItems, { connectionId: CONNECTION, now: T0 });

    // No sync on record: nothing tells the prune what the source still has.
    expect(await prune()).toMatchObject({ deleted: 0, skipped: true });
    // Both toggles off: the sync does not poll it, so lastSeenAt stops.
    await patchConnection(t, { lastSyncOkAt: T0, includeInBrief: false, includeInSearch: false });
    expect(await prune()).toMatchObject({ deleted: 0, skipped: true });
    expect(await t.mutation(internal.mcp.pruneStaleItemsTick, {})).toEqual({ scheduled: 0 });
    // The last sync failed or was partial.
    await patchConnection(t, { includeInBrief: true, lastSyncErrorAt: T0 });
    expect(await prune()).toMatchObject({ deleted: 0, skipped: true });
    expect(await t.mutation(internal.mcp.pruneStaleItemsTick, {})).toEqual({ scheduled: 0 });
    expect((await rows(t)).items.map((row) => row.externalId)).toEqual(['old']);
    // A missing connection row is not pruned either.
    expect(
      await t.mutation(internal.mcp.pruneStaleItems, { connectionId: 'github:none', now: T0 }),
    ).toMatchObject({ skipped: true });

    // A clean sync again: the old item goes.
    await patchConnection(t, { lastSyncErrorAt: undefined });
    expect(await prune()).toMatchObject({ deleted: 1 });
  });

  test('"not seen" counts back from the last clean sync, not from now', async () => {
    const t = newHarness();
    await connect(t);
    // The last clean sync was 10 days ago (for example, the source was down since).
    await patchConnection(t, { lastSyncOkAt: T0 - 10 * DAY });
    await seedItem(t, 'seen-before-last-sync', { lastSeenAt: T0 - 15 * DAY });
    await seedItem(t, 'missed-by-syncs', { lastSeenAt: T0 - 10 * DAY - MCP_ITEM_STALE_MS - DAY });
    const result = await t.mutation(internal.mcp.pruneStaleItems, { connectionId: CONNECTION, now: T0 });
    expect(result).toMatchObject({ deleted: 1, kept: 0 });
    expect((await rows(t)).items.map((row) => row.externalId)).toEqual(['seen-before-last-sync']);
  });

  test('mcpPruneCutoff needs a polled connection with a clean last sync', () => {
    const base = { status: 'connected', includeInBrief: true, includeInSearch: true };
    expect(mcpPruneCutoff(null, T0)).toBeNull();
    expect(mcpPruneCutoff(base, T0)).toBeNull();
    expect(mcpPruneCutoff({ ...base, lastSyncOkAt: T0 - DAY }, T0)).toBe(T0 - DAY - MCP_ITEM_STALE_MS);
    // A clock that runs behind the sync time does not move the cutoff forward.
    expect(mcpPruneCutoff({ ...base, lastSyncOkAt: T0 + DAY }, T0)).toBe(T0 - MCP_ITEM_STALE_MS);
    expect(mcpPruneCutoff({ ...base, lastSyncOkAt: T0, lastSyncErrorAt: T0 }, T0)).toBeNull();
    expect(mcpPruneCutoff({ ...base, status: 'disconnected', lastSyncOkAt: T0 }, T0)).toBeNull();
    expect(
      mcpPruneCutoff({ ...base, includeInBrief: false, includeInSearch: false, lastSyncOkAt: T0 }, T0),
    ).toBeNull();
    expect(mcpPruneCutoff({ ...base, status: 'error', lastSyncOkAt: T0 }, T0)).toBe(T0 - MCP_ITEM_STALE_MS);
  });
});

describe('MCP toggles (X8)', () => {
  test('a connection with both toggles off is not a sync target', async () => {
    const t = newHarness();
    await connect(t);
    await t.mutation(api.mcp.setConnectionToggles, {
      internalSecret: SECRET,
      userId: USER,
      connectionId: CONNECTION,
      includeInBrief: false,
    });
    expect(await t.query(internal.mcp.listSyncTargetUserIds, {})).toEqual([USER]);
    await t.mutation(api.mcp.setConnectionToggles, {
      internalSecret: SECRET,
      userId: USER,
      connectionId: CONNECTION,
      includeInSearch: false,
    });
    expect(await t.query(internal.mcp.listSyncTargetUserIds, {})).toEqual([]);
  });

  test('mcpConnectionWantsSync reads status and both toggles', () => {
    expect(
      mcpConnectionWantsSync({ status: 'connected', includeInBrief: true, includeInSearch: false }),
    ).toBe(true);
    expect(mcpConnectionWantsSync({ status: 'error' })).toBe(true);
    expect(mcpConnectionWantsSync({ status: 'disconnected', includeInBrief: true })).toBe(false);
    expect(
      mcpConnectionWantsSync({ status: 'connected', includeInBrief: false, includeInSearch: false }),
    ).toBe(false);
  });
});
