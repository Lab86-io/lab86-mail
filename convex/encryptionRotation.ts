import { v } from 'convex/values';
import {
  encryptedFieldsFor,
  isEncryptedField,
  patchForEncryptedValue,
  readEncryptedValue,
} from '../lib/security/encrypted-fields';
import { mutation, query } from './_generated/server';
import { requireInternalSecret } from './lib';

// Read and write functions for scripts/rotate-encryption-key.ts. They touch
// only the fields in lib/security/encrypted-fields.ts, and they need the
// server secret. The values stay encrypted here; the script decrypts and
// re-encrypts them with the app keyring.

const MAX_PAGE_SIZE = 200;
// A v2 value from encryptSecret: v2.<kid>.<iv>.<tag>.<ciphertext>.
const V2_VALUE = /^v2\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export const listEncryptedPage = query({
  args: {
    internalSecret: v.optional(v.string()),
    table: v.string(),
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const fields = encryptedFieldsFor(args.table);
    if (!fields.length) throw new Error(`Table ${args.table} holds no registered encrypted fields.`);
    const numItems = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(args.numItems) || 1));
    const page = await (ctx.db as any).query(args.table).paginate({ cursor: args.cursor, numItems });
    return {
      rows: (page.page as Array<Record<string, unknown>>).map((document) => ({
        id: String(document._id),
        values: fields.flatMap((field) => {
          const value = readEncryptedValue(document, field.path);
          return value === undefined ? [] : [{ path: [...field.path], value }];
        }),
      })),
      continueCursor: page.continueCursor as string,
      isDone: page.isDone as boolean,
    };
  },
});

export const replaceEncryptedValue = mutation({
  args: {
    internalSecret: v.optional(v.string()),
    table: v.string(),
    id: v.string(),
    path: v.array(v.string()),
    expected: v.string(),
    next: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    if (!isEncryptedField(args.table, args.path)) {
      throw new Error(`${args.table}.${args.path.join('.')} is not a registered encrypted field.`);
    }
    if (!V2_VALUE.test(args.next)) throw new Error('The new value is not a v2 encrypted value.');
    const id = ctx.db.normalizeId(args.table as any, args.id);
    const document = id ? ((await ctx.db.get(id)) as Record<string, unknown> | null) : null;
    // Compare and set: a row that changed after the read keeps its new value.
    if (!id || !document || readEncryptedValue(document, args.path) !== args.expected) {
      return { replaced: false };
    }
    await ctx.db.patch(id, patchForEncryptedValue(document, args.path, args.next) as any);
    return { replaced: true };
  },
});
