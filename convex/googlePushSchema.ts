import { defineTable } from 'convex/server';
import { v } from 'convex/values';

// Direct Google push (docs/google-direct-transport.md, "Push"). One row is a
// Gmail watch (one for each direct mailbox), a Calendar channel (one for each
// calendar of a direct account), or a Drive changes channel (one for each
// Drive connection). During a renewal a calendar or a Drive connection can
// have two rows for a short time: the new channel and the old one.
export const googlePushTables = {
  googlePushChannels: defineTable({
    userId: v.string(),
    kind: v.union(v.literal('gmail'), v.literal('calendar'), v.literal('drive')),
    // Gmail and Calendar: the mail account and its direct grant at the watch call.
    accountId: v.optional(v.string()),
    grantId: v.optional(v.string()),
    // Calendar: the Google calendar id.
    calendarId: v.optional(v.string()),
    // Drive: the cloud file connection.
    connectionId: v.optional(v.string()),
    // A random UUID. Google sends it back in X-Goog-Channel-ID.
    channelId: v.string(),
    // The watched resource that Google names (X-Goog-Resource-ID).
    resourceId: v.optional(v.string()),
    // SHA-256 (hex) of the channel token. The token itself is never stored.
    tokenHash: v.optional(v.string()),
    status: v.union(v.literal('pending'), v.literal('active'), v.literal('failed')),
    expiration: v.optional(v.number()),
    // Gmail: the mailbox History id that the last watch call returned.
    historyId: v.optional(v.string()),
    // The time before the last watch call, and the time it returned.
    requestedAt: v.number(),
    renewedAt: v.optional(v.number()),
    // The last message from Google for this row.
    lastMessageAt: v.optional(v.number()),
    failures: v.optional(v.number()),
    lastError: v.optional(v.string()),
    retryAfter: v.optional(v.number()),
    // Google cannot watch this calendar (for example a holiday calendar).
    unsupported: v.optional(v.boolean()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_channel', ['channelId'])
    .index('by_user', ['userId'])
    .index('by_user_account', ['userId', 'accountId'])
    .index('by_grant', ['grantId'])
    .index('by_kind_status', ['kind', 'status']),
};
