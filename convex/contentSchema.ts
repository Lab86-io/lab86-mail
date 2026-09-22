import { defineTable } from 'convex/server';
import { v } from 'convex/values';

export const contentTables = {
  contentItems: defineTable({
    userId: v.string(),
    key: v.string(),
    connectionId: v.string(),
    source: v.string(),
    externalId: v.string(),
    title: v.string(),
    text: v.string(),
    url: v.optional(v.string()),
    version: v.string(),
    modifiedAt: v.number(),
    indexedAt: v.number(),
    partial: v.boolean(),
    deleted: v.boolean(),
    labels: v.optional(v.any()),
    status: v.string(),
    attempts: v.number(),
    nextAttemptAt: v.number(),
    lease: v.optional(v.string()),
    leaseUntil: v.optional(v.number()),
    embeddingVersion: v.optional(v.string()),
    scanGeneration: v.optional(v.string()),
  })
    .index('by_user_key', ['userId', 'key'])
    .index('by_user_connection', ['userId', 'connectionId'])
    .index('by_user_updated', ['userId', 'indexedAt'])
    .index('by_user_pending', ['userId', 'status', 'nextAttemptAt'])
    .index('by_user_status_updated', ['userId', 'status', 'indexedAt'])
    .searchIndex('by_text', { searchField: 'text', filterFields: ['userId', 'deleted', 'source'] }),
  contentChunks: defineTable({
    userId: v.string(),
    itemId: v.id('contentItems'),
    version: v.string(),
    text: v.string(),
    embedding: v.array(v.float64()),
  })
    .index('by_item', ['itemId'])
    .vectorIndex('by_embedding', { vectorField: 'embedding', dimensions: 1536, filterFields: ['userId'] }),
  contentSync: defineTable({
    userId: v.string(),
    connectionId: v.string(),
    cursor: v.optional(v.any()),
    status: v.string(),
    indexed: v.number(),
    skipped: v.number(),
    error: v.optional(v.string()),
    updatedAt: v.number(),
    lease: v.optional(v.string()),
    leaseUntil: v.optional(v.number()),
  })
    .index('by_user_connection', ['userId', 'connectionId'])
    .index('by_user', ['userId']),
  briefPreparations: defineTable({
    userId: v.string(),
    key: v.string(),
    seedId: v.id('contentItems'),
    seedVersion: v.string(),
    workId: v.optional(v.id('albatrossIntents')),
    status: v.string(),
    draft: v.optional(v.any()),
    sources: v.array(v.any()),
    userNotes: v.string(),
    userFiles: v.optional(v.any()),
    revision: v.number(),
    preparedAt: v.optional(v.number()),
    updatedAt: v.number(),
    createdAt: v.number(),
    lease: v.optional(v.string()),
    leaseUntil: v.optional(v.number()),
    nextAttemptAt: v.number(),
    error: v.optional(v.string()),
    needsRefresh: v.boolean(),
  })
    .index('by_user_key', ['userId', 'key'])
    .index('by_user_status', ['userId', 'status'])
    .index('by_user_updated', ['userId', 'updatedAt']),
};
