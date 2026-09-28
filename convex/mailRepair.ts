import { v } from 'convex/values';
import { repairFingerprint } from '../lib/mail/repair-fingerprint';
import { query } from './_generated/server';
import { requireInternalSecret } from './lib';

/** A repair page lists at most five pages of 20 messages. */
export const REPAIR_FINGERPRINT_LIMIT = 100;

/**
 * The stored change fingerprint of each listed message (M6). The repair sweep
 * compares it with the provider state and writes only the messages that
 * changed, so an unchanged sweep writes nothing. A missing row, or a row of
 * another user, maps to null, and the sweep writes that message as before.
 */
export const messageFingerprints = query({
  args: {
    internalSecret: v.optional(v.string()),
    userId: v.string(),
    accountId: v.string(),
    providerMessageIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    if (args.providerMessageIds.length > REPAIR_FINGERPRINT_LIMIT) {
      throw new Error('Too many message ids for one repair page.');
    }
    const result: Record<string, string | null> = {};
    for (const providerMessageId of new Set(args.providerMessageIds)) {
      const row = await ctx.db
        .query('mailCorpusMessages')
        .withIndex('by_account_message', (q) =>
          q.eq('accountId', args.accountId).eq('providerMessageId', providerMessageId),
        )
        .unique();
      result[providerMessageId] = row && row.userId === args.userId ? repairFingerprint(row) : null;
    }
    return result;
  },
});
