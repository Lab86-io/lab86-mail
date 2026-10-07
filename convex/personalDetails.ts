import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { now, requireInternalSecret } from './lib';

// Personal details (docs/albatross-thread.md). The rows hold only encrypted
// values. Every function needs the server secret: a signed-in browser never
// reads these rows directly, and only the Next server decrypts them
// (lib/personal-details/store.ts).

/** A user keeps at most this many details (5 fixed keys plus custom facts). */
export const PERSONAL_DETAILS_MAX = 40;
/** How long "Undo" on a save from the chat or a form stays available. */
export const PERSONAL_DETAIL_UNDO_MS = 24 * 60 * 60_000;
const KEY = /^(name|email|phone|home_address|emergency_contact|custom:[a-z0-9][a-z0-9_-]{0,39})$/;
const ENCRYPTED = /^v[12]\.[A-Za-z0-9_.-]+$/;
const sourceValidator = v.union(v.literal('settings'), v.literal('chat'), v.literal('form'));

const serverArgs = { internalSecret: v.optional(v.string()), userId: v.string() };

export const listForUser = query({
  args: serverArgs,
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const rows = await ctx.db
      .query('personalDetails')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .take(PERSONAL_DETAILS_MAX + 1);
    return rows.map((row) => ({
      key: row.key,
      valueEncrypted: row.valueEncrypted,
      source: row.source,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  },
});

export const upsert = mutation({
  args: {
    ...serverArgs,
    key: v.string(),
    valueEncrypted: v.string(),
    source: sourceValidator,
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    if (!KEY.test(args.key)) throw new Error('Unknown personal detail key.');
    if (!ENCRYPTED.test(args.valueEncrypted) || args.valueEncrypted.length > 8_000)
      throw new Error('The value must be an encrypted value.');
    const existing = await ctx.db
      .query('personalDetails')
      .withIndex('by_user_key', (q) => q.eq('userId', args.userId).eq('key', args.key))
      .unique();
    const ts = now();
    // A save from Settings is deliberate and has no Undo. A save from the chat
    // or a form keeps the earlier value for one step of Undo.
    const undoable = args.source !== 'settings';
    if (existing) {
      await ctx.db.patch(existing._id, {
        valueEncrypted: args.valueEncrypted,
        source: args.source,
        previousEncrypted: undoable ? existing.valueEncrypted : undefined,
        previousSource: undoable ? existing.source : undefined,
        undoUntil: undoable ? ts + PERSONAL_DETAIL_UNDO_MS : undefined,
        updatedAt: ts,
      });
      return { created: false };
    }
    const count = (
      await ctx.db
        .query('personalDetails')
        .withIndex('by_user', (q) => q.eq('userId', args.userId))
        .take(PERSONAL_DETAILS_MAX + 1)
    ).length;
    if (count >= PERSONAL_DETAILS_MAX) throw new Error('You keep the most personal details allowed.');
    await ctx.db.insert('personalDetails', {
      userId: args.userId,
      key: args.key,
      valueEncrypted: args.valueEncrypted,
      source: args.source,
      undoUntil: undoable ? ts + PERSONAL_DETAIL_UNDO_MS : undefined,
      createdAt: ts,
      updatedAt: ts,
    });
    return { created: true };
  },
});

/**
 * Undo the newest save from the chat or a form: restore the earlier value, or
 * delete the row when that save created it. Returns what happened.
 */
export const undoSave = mutation({
  args: { ...serverArgs, key: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const existing = await ctx.db
      .query('personalDetails')
      .withIndex('by_user_key', (q) => q.eq('userId', args.userId).eq('key', args.key))
      .unique();
    if (!existing?.undoUntil || existing.undoUntil < now()) return { undone: 'none' as const };
    if (existing.previousEncrypted) {
      await ctx.db.patch(existing._id, {
        valueEncrypted: existing.previousEncrypted,
        source: existing.previousSource ?? 'settings',
        previousEncrypted: undefined,
        previousSource: undefined,
        undoUntil: undefined,
        updatedAt: now(),
      });
      return { undone: 'restored' as const };
    }
    await ctx.db.delete(existing._id);
    return { undone: 'removed' as const };
  },
});

export const remove = mutation({
  args: { ...serverArgs, key: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const existing = await ctx.db
      .query('personalDetails')
      .withIndex('by_user_key', (q) => q.eq('userId', args.userId).eq('key', args.key))
      .unique();
    if (!existing) return { removed: false };
    await ctx.db.delete(existing._id);
    return { removed: true };
  },
});
