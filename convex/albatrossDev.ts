import { v } from 'convex/values';
import type { MutationCtx } from './_generated/server';
import { mutation, query } from './_generated/server';
import { now, requireInternalSecret } from './lib';

const SEED_SOURCE = 'albatross-0.9.seed';

type SeedFixture = {
  seedUser?: {
    userId?: string;
    email?: string;
    name?: string;
  };
  tables?: Record<string, unknown[]>;
};

function keyFor(kind: string, item: unknown, index: number) {
  if (item && typeof item === 'object' && 'id' in item && typeof item.id === 'string') {
    return item.id;
  }
  return `${kind}_${index + 1}`;
}

function refFor(item: unknown) {
  if (!item || typeof item !== 'object') return undefined;
  const value = item as Record<string, unknown>;
  for (const field of ['areaId', 'intentId', 'projectId', 'artifactId', 'accountId']) {
    if (typeof value[field] === 'string') return `${field}:${value[field]}`;
  }
  return undefined;
}

async function upsertSeedUser(
  ctx: MutationCtx,
  userId: string,
  seedUser: NonNullable<SeedFixture['seedUser']>,
) {
  const ts = now();
  const existing = await ctx.db
    .query('users')
    .withIndex('by_clerk_user_id', (q) => q.eq('clerkUserId', userId))
    .unique();
  const email = seedUser.email || 'albatross-dev@example.test';
  const name = seedUser.name || 'Albatross Dev User';
  if (existing) {
    await ctx.db.patch(existing._id, { email, name, updatedAt: ts });
    return existing._id;
  }
  return await ctx.db.insert('users', {
    clerkUserId: userId,
    email,
    name,
    createdAt: ts,
    updatedAt: ts,
  });
}

export const seedFromFixture = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.optional(v.string()),
    fixture: v.any(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const fixture = args.fixture as SeedFixture;
    const seedUser = fixture.seedUser || {};
    const userId = args.userId || seedUser.userId;
    if (!userId) throw new Error('userId is required.');

    await upsertSeedUser(ctx, userId, { ...seedUser, userId });

    const existing = await ctx.db
      .query('albatrossDevRecords')
      .withIndex('by_user_source', (q) => q.eq('userId', userId).eq('source', SEED_SOURCE))
      .collect();
    await Promise.all(existing.map((record) => ctx.db.delete(record._id)));

    const ts = now();
    const counts: Record<string, number> = {};
    const tables = fixture.tables || {};
    for (const [kind, rows] of Object.entries(tables)) {
      if (!Array.isArray(rows)) continue;
      counts[kind] = rows.length;
      for (const [index, item] of rows.entries()) {
        await ctx.db.insert('albatrossDevRecords', {
          userId,
          kind,
          key: keyFor(kind, item, index),
          ref: refFor(item),
          source: SEED_SOURCE,
          doc: item,
          createdAt: ts,
          updatedAt: ts,
        });
      }
    }

    await ctx.db.insert('albatrossDevRecords', {
      userId,
      kind: 'seedMetadata',
      key: 'albatross-0.9',
      source: SEED_SOURCE,
      doc: {
        schemaVersion: (args.fixture as any)?.schemaVersion,
        generatedAt: (args.fixture as any)?.generatedAt,
        description: (args.fixture as any)?.description,
        seededAt: ts,
      },
      createdAt: ts,
      updatedAt: ts,
    });
    counts.seedMetadata = 1;

    return { userId, source: SEED_SOURCE, counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
  },
});

export const summary = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const records = await ctx.db
      .query('albatrossDevRecords')
      .withIndex('by_user_source', (q) => q.eq('userId', args.userId).eq('source', SEED_SOURCE))
      .collect();
    const counts: Record<string, number> = {};
    for (const record of records) counts[record.kind] = (counts[record.kind] || 0) + 1;
    return { userId: args.userId, source: SEED_SOURCE, counts, total: records.length };
  },
});

export const listByKind = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    kind: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    return await ctx.db
      .query('albatrossDevRecords')
      .withIndex('by_user_source', (q) => q.eq('userId', args.userId).eq('source', SEED_SOURCE))
      .filter((q) => q.eq(q.field('kind'), args.kind))
      .collect();
  },
});
