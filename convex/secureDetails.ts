import { v } from 'convex/values';
import { truncateText } from '../lib/shared/text';
import { internal } from './_generated/api';
import { internalMutation, mutation, query } from './_generated/server';
import { now, requireInternalSecret } from './lib';

// Secure details (docs/albatross-secure-store.md). The rows hold sealed
// values only, and no function here opens them: the Next server seals and
// opens (lib/secure/crypto.ts). Every function needs the server secret, so a
// signed-in browser never reads these rows directly. No function returns a
// sealed value except the two the server needs at the moment of use and for
// key rotation.

/** A user keeps at most this many items (lib/secure/policy.ts SECURE_ITEMS_MAX). */
export const SECURE_ITEMS_MAX = 100;
/** An item works on at most this many sites. */
export const SECURE_SITES_MAX = 20;
/** Use history is kept this long. */
export const SECURE_USE_RETENTION_MS = 90 * 24 * 60 * 60_000;
/** Rows that one prune pass deletes from each table. */
export const PRUNE_BATCH = 500;
/** "Allow once" lasts this long at most. */
export const SECURE_GRANT_MAX_MS = 2 * 60 * 60_000;

const ITEM_ID = /^si_[A-Za-z0-9_-]{16,40}$/;
const SEALED = /^sv1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const KEK_ID = /^[A-Za-z0-9_-]{1,32}$/;
const SITE = /^[a-z0-9.-]{1,253}$/;

const serverArgs = { internalSecret: v.optional(v.string()), userId: v.string() };
const kindValidator = v.union(
  v.literal('sign_in'),
  v.literal('id_number'),
  v.literal('date_of_birth'),
  v.literal('api_key'),
);
const hintsValidator = v.array(v.object({ field: v.string(), hint: v.string() }));
const factsValidator = v.array(v.object({ name: v.string(), value: v.string() }));
const sealedValidator = v.object({
  payloadSealed: v.string(),
  dataKeyWrapped: v.string(),
  kekId: v.string(),
});
const outcomeValidator = v.union(
  v.literal('typed'),
  v.literal('sent'),
  v.literal('refused_site'),
  v.literal('asked'),
  v.literal('allowed_once'),
  v.literal('allowed_always'),
  v.literal('denied'),
);

function checkSealed(sealed: { payloadSealed: string; dataKeyWrapped: string; kekId: string }) {
  if (
    !SEALED.test(sealed.payloadSealed) ||
    sealed.payloadSealed.length > 16_000 ||
    !SEALED.test(sealed.dataKeyWrapped) ||
    sealed.dataKeyWrapped.length > 400 ||
    !KEK_ID.test(sealed.kekId)
  )
    throw new Error('The value must be sealed.');
}

function checkSites(sites: readonly string[]) {
  if (sites.length > SECURE_SITES_MAX) throw new Error('Too many sites.');
  for (const site of sites) if (!SITE.test(site) || !site.includes('.')) throw new Error('Invalid site.');
}

function checkShown(rows: Array<{ field?: string; name?: string; hint?: string; value?: string }>) {
  if (rows.length > 12) throw new Error('Too many hints or facts.');
  for (const row of rows) {
    const text = `${row.field ?? row.name ?? ''}${row.hint ?? row.value ?? ''}`;
    if (text.length > 120) throw new Error('A hint or fact is too long.');
  }
}

function itemView(row: {
  itemId: string;
  kind: string;
  label: string;
  sites: string[];
  hints: Array<{ field: string; hint: string }>;
  facts: Array<{ name: string; value: string }>;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}) {
  return {
    itemId: row.itemId,
    kind: row.kind,
    label: row.label,
    sites: row.sites,
    hints: row.hints,
    facts: row.facts,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastUsedAt: row.lastUsedAt ?? null,
  };
}

async function ownedItem(ctx: any, userId: string, itemId: string) {
  if (!ITEM_ID.test(itemId)) return null;
  return ctx.db
    .query('secureItems')
    .withIndex('by_user_item', (q: any) => q.eq('userId', userId).eq('itemId', itemId))
    .unique();
}

/** Every item of a user, without sealed values. */
export const listItems = query({
  args: serverArgs,
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const rows = await ctx.db
      .query('secureItems')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .take(SECURE_ITEMS_MAX + 1);
    return rows.map(itemView);
  },
});

/** Every item of a user with its sealed values, for a run that uses or scrubs them. */
export const listSealed = query({
  args: serverArgs,
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const rows = await ctx.db
      .query('secureItems')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .take(SECURE_ITEMS_MAX + 1);
    return rows.map((row) => ({
      ...itemView(row),
      payloadSealed: row.payloadSealed,
      dataKeyWrapped: row.dataKeyWrapped,
      kekId: row.kekId,
    }));
  },
});

export const createItem = mutation({
  args: {
    ...serverArgs,
    itemId: v.string(),
    kind: kindValidator,
    label: v.string(),
    sites: v.array(v.string()),
    hints: hintsValidator,
    facts: factsValidator,
    sealed: sealedValidator,
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    if (!ITEM_ID.test(args.itemId)) throw new Error('Invalid item id.');
    const label = args.label.trim();
    if (!label || label.length > 80) throw new Error('Invalid label.');
    checkSites(args.sites);
    checkShown(args.hints);
    checkShown(args.facts);
    checkSealed(args.sealed);
    if (await ownedItem(ctx, args.userId, args.itemId)) throw new Error('The item already exists.');
    const count = (
      await ctx.db
        .query('secureItems')
        .withIndex('by_user', (q) => q.eq('userId', args.userId))
        .take(SECURE_ITEMS_MAX + 1)
    ).length;
    if (count >= SECURE_ITEMS_MAX) throw new Error('You keep the most items allowed.');
    const ts = now();
    await ctx.db.insert('secureItems', {
      userId: args.userId,
      itemId: args.itemId,
      kind: args.kind,
      label,
      sites: args.sites,
      hints: args.hints,
      facts: args.facts,
      ...args.sealed,
      createdAt: ts,
      updatedAt: ts,
    });
    return { itemId: args.itemId };
  },
});

/**
 * Change the label, the sites, or the values of an item. The Next route
 * decides the identity check for a new site before it calls this.
 */
export const updateItem = mutation({
  args: {
    ...serverArgs,
    itemId: v.string(),
    label: v.optional(v.string()),
    sites: v.optional(v.array(v.string())),
    hints: v.optional(hintsValidator),
    facts: v.optional(factsValidator),
    sealed: v.optional(sealedValidator),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ownedItem(ctx, args.userId, args.itemId);
    if (!row) return { updated: false };
    const patch: Record<string, unknown> = { updatedAt: now() };
    if (args.label !== undefined) {
      const label = args.label.trim();
      if (!label || label.length > 80) throw new Error('Invalid label.');
      patch.label = label;
    }
    if (args.sites) {
      checkSites(args.sites);
      patch.sites = args.sites;
    }
    if (args.hints) {
      checkShown(args.hints);
      patch.hints = args.hints;
    }
    if (args.facts) {
      checkShown(args.facts);
      patch.facts = args.facts;
    }
    if (args.sealed) {
      checkSealed(args.sealed);
      Object.assign(patch, args.sealed);
    }
    await ctx.db.patch(row._id, patch);
    // New values or fewer sites end every "Allow once" for the item.
    if (args.sealed || args.sites) {
      const grants = await ctx.db
        .query('secureGrants')
        .withIndex('by_user_item', (q) => q.eq('userId', args.userId).eq('itemId', args.itemId))
        .take(200);
      for (const grant of grants) await ctx.db.delete(grant._id);
    }
    return { updated: true };
  },
});

/** Add one site to an item ("Always on this site"). */
export const addSite = mutation({
  args: { ...serverArgs, itemId: v.string(), site: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ownedItem(ctx, args.userId, args.itemId);
    if (!row) return { added: false };
    if (row.sites.includes(args.site)) return { added: false };
    const sites = [...row.sites, args.site];
    checkSites(sites);
    await ctx.db.patch(row._id, { sites, updatedAt: now() });
    return { added: true };
  },
});

/** Delete an item with its grants and its use history. */
export const deleteItem = mutation({
  args: { ...serverArgs, itemId: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ownedItem(ctx, args.userId, args.itemId);
    if (!row) return { deleted: false };
    await ctx.db.delete(row._id);
    const grants = await ctx.db
      .query('secureGrants')
      .withIndex('by_user_item', (q) => q.eq('userId', args.userId).eq('itemId', args.itemId))
      .take(500);
    for (const grant of grants) await ctx.db.delete(grant._id);
    const uses = await ctx.db
      .query('secureUses')
      .withIndex('by_user_item_at', (q) => q.eq('userId', args.userId).eq('itemId', args.itemId))
      .take(2_000);
    for (const use of uses) await ctx.db.delete(use._id);
    return { deleted: true };
  },
});

/** "Allow once": the item on one site for one step, until expiresAt. */
export const grantOnce = mutation({
  args: {
    ...serverArgs,
    itemId: v.string(),
    site: v.string(),
    workId: v.string(),
    stepKey: v.string(),
    ttlMs: v.number(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    if (!(await ownedItem(ctx, args.userId, args.itemId))) return { granted: false };
    checkSites([args.site]);
    const ts = now();
    await ctx.db.insert('secureGrants', {
      userId: args.userId,
      itemId: args.itemId,
      site: args.site,
      workId: args.workId,
      stepKey: args.stepKey,
      expiresAt: ts + Math.min(Math.max(args.ttlMs, 60_000), SECURE_GRANT_MAX_MS),
      createdAt: ts,
    });
    return { granted: true };
  },
});

/** True when an "Allow once" covers this item, site, and step now. */
export const hasGrant = query({
  args: { ...serverArgs, itemId: v.string(), site: v.string(), workId: v.string(), stepKey: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const ts = now();
    const grants = await ctx.db
      .query('secureGrants')
      .withIndex('by_user_item', (q) => q.eq('userId', args.userId).eq('itemId', args.itemId))
      .take(200);
    return grants.some(
      (grant) =>
        grant.site === args.site &&
        grant.workId === args.workId &&
        grant.stepKey === args.stepKey &&
        grant.expiresAt > ts,
    );
  },
});

/** One line of use history. A use that typed or sent the value also sets lastUsedAt. */
export const recordUse = mutation({
  args: {
    ...serverArgs,
    itemId: v.string(),
    field: v.optional(v.string()),
    site: v.optional(v.string()),
    host: v.optional(v.string()),
    workId: v.optional(v.string()),
    runId: v.optional(v.string()),
    outcome: outcomeValidator,
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ownedItem(ctx, args.userId, args.itemId);
    if (!row) return { recorded: false };
    const ts = now();
    const clip = (value: string | undefined, max: number) => (value ? truncateText(value, max) : undefined);
    await ctx.db.insert('secureUses', {
      userId: args.userId,
      itemId: args.itemId,
      field: clip(args.field, 32),
      site: clip(args.site, 253),
      host: clip(args.host, 253),
      workId: clip(args.workId, 120),
      runId: clip(args.runId, 120),
      outcome: args.outcome,
      at: ts,
    });
    if (args.outcome === 'typed' || args.outcome === 'sent') await ctx.db.patch(row._id, { lastUsedAt: ts });
    return { recorded: true };
  },
});

/** The newest uses of one item, newest first. */
export const listUses = query({
  args: { ...serverArgs, itemId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 50), 1), 200);
    const rows = await ctx.db
      .query('secureUses')
      .withIndex('by_user_item_at', (q) => q.eq('userId', args.userId).eq('itemId', args.itemId))
      .order('desc')
      .take(limit);
    // The title of each Work, so the history says which Albatross used it.
    const titles = new Map<string, string | null>();
    for (const workId of new Set(rows.map((row) => row.workId).filter(Boolean) as string[])) {
      const id = ctx.db.normalizeId('albatrossIntents', workId);
      const work = id ? await ctx.db.get(id) : null;
      titles.set(
        workId,
        work && work.userId === args.userId
          ? truncateText(String(work.title || work.rawText || ''), 120) || null
          : null,
      );
    }
    return rows.map((row) => ({
      id: String(row._id),
      itemId: row.itemId,
      field: row.field ?? null,
      site: row.site ?? null,
      host: row.host ?? null,
      workId: row.workId ?? null,
      workTitle: row.workId ? (titles.get(row.workId) ?? null) : null,
      runId: row.runId ?? null,
      outcome: row.outcome,
      at: row.at,
    }));
  },
});

/** Every 6 hours: use history older than 90 days and ended grants go. A full batch runs again at once. */
export const prune = internalMutation({
  args: {},
  handler: async (ctx) => {
    const ts = now();
    const uses = await ctx.db
      .query('secureUses')
      .withIndex('by_at', (q) => q.lt('at', ts - SECURE_USE_RETENTION_MS))
      .take(PRUNE_BATCH);
    for (const use of uses) await ctx.db.delete(use._id);
    const grants = await ctx.db
      .query('secureGrants')
      .withIndex('by_expires', (q) => q.lt('expiresAt', ts))
      .take(PRUNE_BATCH);
    for (const grant of grants) await ctx.db.delete(grant._id);
    // The 90-day promise holds however many rows expire: a full batch schedules the next one now.
    if (uses.length === PRUNE_BATCH || grants.length === PRUNE_BATCH)
      await ctx.scheduler.runAfter(0, internal.secureDetails.prune, {});
    return { uses: uses.length, grants: grants.length };
  },
});

/** A page of every item's wrapped data key, for scripts/rotate-secure-kek.ts. */
export const rotationPage = query({
  args: {
    internalSecret: v.optional(v.string()),
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const page = await ctx.db
      .query('secureItems')
      .paginate({ cursor: args.cursor, numItems: Math.min(Math.max(args.numItems, 1), 200) });
    return {
      rows: page.page.map((row) => ({
        id: String(row._id),
        userId: row.userId,
        itemId: row.itemId,
        kind: row.kind,
        dataKeyWrapped: row.dataKeyWrapped,
        kekId: row.kekId,
      })),
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/** Replace one wrapped data key when the row still holds the key that was read. */
export const rewrap = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    id: v.id('secureItems'),
    expected: v.string(),
    dataKeyWrapped: v.string(),
    kekId: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ctx.db.get(args.id);
    if (!row || row.dataKeyWrapped !== args.expected) return { replaced: false };
    if (!SEALED.test(args.dataKeyWrapped) || !KEK_ID.test(args.kekId))
      throw new Error('The key must be sealed.');
    await ctx.db.patch(row._id, { dataKeyWrapped: args.dataKeyWrapped, kekId: args.kekId });
    return { replaced: true };
  },
});
