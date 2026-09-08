import { defineTable } from 'convex/server';
import { v } from 'convex/values';

export const narrativeLevel = v.union(
  v.literal('observation'),
  v.literal('day'),
  v.literal('week'),
  v.literal('month'),
  v.literal('thread'),
);
export const narrativeTrust = v.union(v.literal('observed'), v.literal('reported'), v.literal('inferred'));

export const narrativeTables = {
  narrativeSettings: defineTable({
    userId: v.string(),
    enabled: v.boolean(),
    sources: v.array(v.string()),
    timezone: v.string(),
    model: v.string(),
    revision: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    lastRunAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    cleaning: v.optional(v.boolean()),
    lease: v.optional(v.string()),
    leaseUntil: v.optional(v.number()),
    dailyRunDate: v.optional(v.string()),
    dailyRuns: v.optional(v.number()),
  })
    .index('by_user', ['userId'])
    .index('by_enabled', ['enabled']),
  narrativeEntries: defineTable({
    userId: v.string(),
    key: v.string(),
    level: narrativeLevel,
    title: v.string(),
    text: v.string(),
    source: v.string(),
    sourceTable: v.optional(v.string()),
    sourceId: v.optional(v.string()),
    sourceVersion: v.optional(v.string()),
    sourceBaseVersion: v.optional(v.string()),
    sourceIds: v.array(v.string()),
    sourceVersions: v.optional(v.record(v.string(), v.string())),
    topics: v.array(v.string()),
    trust: narrativeTrust,
    occurredAt: v.number(),
    observedAt: v.number(),
    updatedAt: v.number(),
    current: v.boolean(),
    pinned: v.boolean(),
    url: v.optional(v.string()),
    accountId: v.optional(v.string()),
    period: v.optional(v.string()),
    corrected: v.optional(v.boolean()),
    model: v.optional(v.string()),
    coverage: v.optional(v.string()),
  })
    .index('by_user', ['userId'])
    .index('by_user_key', ['userId', 'key'])
    .index('by_user_level_time', ['userId', 'level', 'occurredAt'])
    .index('by_user_level_model_time', ['userId', 'level', 'model', 'occurredAt'])
    .index('by_user_updated', ['userId', 'updatedAt'])
    .index('by_user_source', ['userId', 'source'])
    .index('by_user_current_time', ['userId', 'current', 'occurredAt'])
    .index('by_user_pinned', ['userId', 'pinned', 'occurredAt'])
    .index('by_user_level_pinned', ['userId', 'level', 'pinned', 'occurredAt'])
    .searchIndex('by_text', { searchField: 'text', filterFields: ['userId', 'current', 'level'] }),
  narrativeCursors: defineTable({
    userId: v.string(),
    group: v.string(),
    cursor: v.optional(v.string()),
    since: v.number(),
    until: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user_group', ['userId', 'group'])
    .index('by_user', ['userId']),
  // No forgotten text is retained here. Stable identities prevent backfill resurrection.
  narrativeExclusions: defineTable({ userId: v.string(), key: v.string() })
    .index('by_user_key', ['userId', 'key'])
    .index('by_user', ['userId']),
  narrativeRuns: defineTable({
    userId: v.string(),
    runId: v.string(),
    kind: v.string(),
    status: v.string(),
    startedAt: v.number(),
    endedAt: v.optional(v.number()),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    model: v.optional(v.string()),
    error: v.optional(v.string()),
    sourceCount: v.optional(v.number()),
  })
    .index('by_user', ['userId'])
    .index('by_user_run', ['userId', 'runId']),
};
