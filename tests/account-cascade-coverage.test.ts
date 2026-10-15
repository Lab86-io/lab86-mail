import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { convexTest, type TestConvex } from 'convex-test';
import { api, internal } from '../convex/_generated/api';
import {
  ACCOUNT_BULK_TABLES,
  ACCOUNT_PURGE_INDEX,
  CASCADE_EXEMPT_TABLES,
  CASCADE_SPECIAL_TABLES,
  USER_BULK_TABLES,
  USER_INDEXES,
  USER_INLINE_TABLES,
} from '../convex/accounts';
import schema from '../convex/schema';

const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/accounts.ts': () => import('../convex/accounts'),
};

type TableShape = { fields: string[]; indexes: Array<{ name: string; fields: string[] }> };

function schemaTables(): Record<string, TableShape> {
  const out: Record<string, TableShape> = {};
  for (const [name, table] of Object.entries<any>((schema as any).tables)) {
    out[name] = {
      fields: Object.keys(table.validator?.fields ?? {}),
      indexes: (table.indexes ?? []).map((index: any) => ({
        name: index.indexDescriptor,
        fields: index.fields,
      })),
    };
  }
  return out;
}

describe('account deletion cascade coverage', () => {
  const tables = schemaTables();
  const swept = new Set<string>([...USER_INLINE_TABLES, ...USER_BULK_TABLES, ...ACCOUNT_BULK_TABLES]);

  test('every schema table with a userId field is deleted or exempt with a reason', () => {
    const uncovered = Object.entries(tables)
      .filter(([, table]) => table.fields.includes('userId'))
      .map(([name]) => name)
      .filter(
        (name) => !swept.has(name) && !(name in CASCADE_SPECIAL_TABLES) && !(name in CASCADE_EXEMPT_TABLES),
      );
    expect(uncovered).toEqual([]);
    for (const [name, reason] of Object.entries(CASCADE_EXEMPT_TABLES)) {
      expect(tables[name], `${name} is exempt but is not in the schema`).toBeDefined();
      expect(reason.trim().length).toBeGreaterThan(10);
    }
  });

  test('every account table has the (userId, accountId) index that the account purge reads', () => {
    const missing = ACCOUNT_BULK_TABLES.filter((name) => {
      const indexName = ACCOUNT_PURGE_INDEX[name] ?? 'by_user_account';
      const index = tables[name]?.indexes.find((entry) => entry.name === indexName);
      return !index || index.fields[0] !== 'userId' || index.fields[1] !== 'accountId';
    });
    expect(missing).toEqual([]);
  });

  test('every swept table has an index that the sweep can read by userId', () => {
    const unreadable = [...swept].filter((name) => {
      const table = tables[name];
      if (!table) return true;
      return !table.indexes.some(
        (index) => (USER_INDEXES as readonly string[]).includes(index.name) && index.fields[0] === 'userId',
      );
    });
    expect(unreadable).toEqual([]);
  });
});

describe('account deletion removes narrative and content rows', () => {
  const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  beforeEach(() => {
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'cascade-secret';
  });
  afterEach(() => {
    if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
    else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
  });

  async function seed(t: TestConvex<typeof schema>, userId: string) {
    await t.run(async (ctx) => {
      const ts = 1_700_000_000_000;
      await ctx.db.insert('narrativeSettings', {
        userId,
        enabled: true,
        sources: ['mail'],
        timezone: 'UTC',
        model: 'model',
        revision: 1,
        createdAt: ts,
        updatedAt: ts,
      });
      await ctx.db.insert('narrativeEntries', {
        userId,
        key: 'k',
        level: 'observation',
        title: 'Title',
        text: 'Private text',
        source: 'mail',
        sourceIds: [],
        topics: [],
        trust: 'observed',
        occurredAt: ts,
        observedAt: ts,
        updatedAt: ts,
        current: true,
        pinned: false,
      });
      await ctx.db.insert('narrativeCursors', { userId, group: 'mail', since: ts, until: ts, updatedAt: ts });
      await ctx.db.insert('narrativeExclusions', { userId, key: 'k' });
      await ctx.db.insert('narrativeRuns', {
        userId,
        runId: 'r',
        kind: 'day',
        status: 'done',
        startedAt: ts,
      });
      const itemId = await ctx.db.insert('contentItems', {
        userId,
        key: 'doc:1',
        connectionId: 'c',
        source: 'mcp',
        externalId: '1',
        title: 'Doc',
        text: 'Private document',
        version: '1',
        modifiedAt: ts,
        indexedAt: ts,
        partial: false,
        deleted: false,
        status: 'ready',
        attempts: 0,
        nextAttemptAt: 0,
      });
      for (let i = 0; i < 3; i++) {
        await ctx.db.insert('contentChunks', {
          userId,
          itemId,
          version: '1',
          text: `chunk ${i}`,
          embedding: Array.from({ length: 1536 }, () => 0),
        });
      }
      await ctx.db.insert('contentSync', {
        userId,
        connectionId: 'c',
        status: 'idle',
        indexed: 1,
        skipped: 0,
        updatedAt: ts,
      });
      await ctx.db.insert('briefPreparations', {
        userId,
        key: 'prep',
        seedId: itemId,
        seedVersion: '1',
        status: 'pending',
        sources: [],
        userNotes: 'notes',
        revision: 1,
        updatedAt: ts,
        createdAt: ts,
        nextAttemptAt: 0,
        needsRefresh: false,
      });
    });
  }

  const checked = [
    'narrativeSettings',
    'narrativeEntries',
    'narrativeCursors',
    'narrativeExclusions',
    'narrativeRuns',
    'contentItems',
    'contentChunks',
    'contentSync',
    'briefPreparations',
  ] as const;

  test('cascade and batch purge delete every row of the user and keep other users', async () => {
    const t = convexTest(schema, modules);
    await seed(t, 'gone_user');
    await seed(t, 'kept_user');

    await t.mutation(api.accounts.deleteUserCascade, {
      internalSecret: 'cascade-secret',
      userId: 'gone_user',
    });
    for (let pass = 0; pass < 10; pass++) {
      const { deleted } = await t.mutation(internal.accounts.purgeUserDataBatch, { userId: 'gone_user' });
      if (deleted === 0) break;
    }

    for (const table of checked) {
      const rows = await t.run((ctx) => ctx.db.query(table).collect());
      expect(
        rows.filter((row: any) => row.userId === 'gone_user'),
        table,
      ).toHaveLength(0);
      expect(rows.filter((row: any) => row.userId === 'kept_user').length, table).toBeGreaterThan(0);
    }
  });
});

describe('account deletion removes saved files, drafts with files, and held sends (goal runs)', () => {
  const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  beforeEach(() => {
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'cascade-secret';
  });
  afterEach(() => {
    if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
    else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
  });

  test('a filled form with sealed fields, its stored bytes, a draft with files, and a held send go', async () => {
    const t = convexTest(schema, modules);
    const stored: Record<string, string> = {};
    await t.run(async (ctx) => {
      for (const userId of ['gone_user', 'kept_user']) {
        const storageId = await ctx.storage.store(new Blob(['%PDF-1.7']));
        stored[userId] = storageId;
        await ctx.db.insert('agentUploads', {
          userId,
          storageId,
          name: 'fw9 (filled).pdf',
          contentType: 'application/pdf',
          size: 8,
          createdAt: 1,
          origin: 'filled',
          sealedFields: [{ field: 'f1_11[0]', ref: '{{secure:si_ssn_000000000000000001.number|AREA}}' }],
        });
        await ctx.db.insert('userDocs', {
          userId,
          kind: 'draft',
          key: 'draft_1',
          doc: {
            attachments: [
              { source: 'file', fileId: 'x', provider: 'upload', format: 'native', name: 'a.pdf' },
            ],
          },
          createdAt: 1,
          updatedAt: 1,
        });
        const payloadId = await ctx.storage.store(
          new Blob([JSON.stringify({ sealedAttachments: [{ fileId: 'x', filename: 'a.pdf' }] })]),
        );
        await ctx.db.insert('mailOutbox', {
          userId,
          key: `outbox:${crypto.randomUUID()}`,
          payloadId,
          status: 'pending',
          fireAt: 1,
          undoSeconds: 10,
          updatedAt: 1,
        });
      }
    });
    await t.mutation(api.accounts.deleteUserCascade, {
      internalSecret: 'cascade-secret',
      userId: 'gone_user',
    });
    for (let pass = 0; pass < 10; pass++) {
      const { deleted } = await t.mutation(internal.accounts.purgeUserDataBatch, { userId: 'gone_user' });
      if (deleted === 0) break;
    }
    for (const table of ['agentUploads', 'userDocs', 'mailOutbox'] as const) {
      const rows = await t.run((ctx) => ctx.db.query(table).collect());
      expect(
        rows.filter((row: any) => row.userId === 'gone_user'),
        table,
      ).toHaveLength(0);
      expect(
        rows.filter((row: any) => row.userId === 'kept_user'),
        table,
      ).toHaveLength(1);
    }
    expect(await t.run((ctx) => ctx.storage.getUrl(stored.gone_user as any))).toBeNull();
    expect(await t.run((ctx) => ctx.storage.getUrl(stored.kept_user as any))).not.toBeNull();
  });
});
