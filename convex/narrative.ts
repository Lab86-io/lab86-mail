import { v } from 'convex/values';
import {
  cleanNarrativeProse,
  cleanNarrativeText,
  fallbackChapter,
  type NarrativeEntry,
  narrativePeriods,
  rankNarrative,
  selectBriefEvidence,
} from '../lib/narrative/core';
import { type Observation, observationsForRow } from '../lib/narrative/observations';
import { internal } from './_generated/api';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { internalAction, internalMutation, internalQuery, mutation, query } from './_generated/server';
import { fanOutInternalPost, requireInternalSecret } from './lib';
import { narrativeLevel } from './narrativeSchema';

const caller = { internalSecret: v.optional(v.string()), userId: v.optional(v.string()) };
async function owner(ctx: QueryCtx | MutationCtx, args: { internalSecret?: string; userId?: string }) {
  if (args.internalSecret !== undefined) {
    requireInternalSecret(args.internalSecret);
    if (!args.userId) throw new Error('User required');
    return args.userId;
  }
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error('Not authenticated');
  return identity.subject;
}
async function settings(ctx: QueryCtx | MutationCtx, userId: string) {
  return ctx.db
    .query('narrativeSettings')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .unique();
}
async function allowed(ctx: QueryCtx | MutationCtx, userId: string, source: string, prefs: any) {
  if (!prefs?.enabled || !prefs.sources.includes(source)) return false;
  if (source.startsWith('mcp:')) {
    const connection = await ctx.db
      .query('mcpConnections')
      .withIndex('by_user_connection', (q) => q.eq('userId', userId).eq('connectionId', source.slice(4)))
      .unique();
    return Boolean(connection && connection.status !== 'disconnected');
  }
  if (/^(mail|calendar):/.test(source)) {
    const account = await ctx.db
      .query('connectedAccounts')
      .withIndex('by_user_account', (q) =>
        q.eq('userId', userId).eq('accountId', source.slice(source.indexOf(':') + 1)),
      )
      .unique();
    return Boolean(account && account.status !== 'disconnected');
  }
  return true;
}
async function visible(ctx: QueryCtx | MutationCtx, row: any, prefs: any) {
  if (!row || row.userId !== prefs?.userId || !prefs.enabled) return false;
  if (row.level === 'observation') {
    if (!(await allowed(ctx, row.userId, row.source, prefs))) return false;
    if (
      await ctx.db
        .query('narrativeExclusions')
        .withIndex('by_user_key', (q) => q.eq('userId', row.userId).eq('key', row.key))
        .unique()
    )
      return false;
    if (row.sourceTable && row.sourceId) {
      const original: any = await ctx.db.get(row.sourceId);
      if (
        !original ||
        original.userId !== row.userId ||
        original.archivedAt ||
        ['rejected', 'superseded'].includes(original.status)
      )
        return false;
      if (row.current && ['aiOperations', 'albatrossIntents'].includes(row.sourceTable)) {
        const baseline = row.corrected ? row.sourceBaseVersion : row.sourceVersion;
        const receipt = observationsForRow(row.sourceTable, original).find((item) => item.key === row.key);
        if (!receipt || (baseline && receipt.sourceVersion !== baseline)) return false;
      }
    }
    return true;
  }
  for (const id of row.sourceIds) {
    const child: any = await ctx.db.get(id);
    if (!child || child.level !== 'observation' || !(await visible(ctx, child, prefs))) return false;
    if (row.sourceVersions && row.sourceVersions[id] !== (child.sourceVersion || '')) return false;
    // Old chapters can explain what used to be true. Current Work threads and
    // the morning account must instead resolve against current source versions.
    if ((row.level === 'thread' || row.key.startsWith('brief:')) && !child.current) return false;
  }
  return row.sourceIds.length > 0;
}
async function invalidate(ctx: MutationCtx, userId: string) {
  // Read-time version/consent checks revoke access immediately. Physical cleanup
  // is bounded, and must never delete an unrelated older chapter.
  await ctx.scheduler.runAfter(0, (internal as any).narrative.cleanup, { userId });
}

export const status = query({
  args: caller,
  handler: async (ctx, args) => {
    const userId = await owner(ctx, args);
    const prefs = await settings(ctx, userId);
    const [accounts, connections, runs] = await Promise.all([
      ctx.db
        .query('connectedAccounts')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .collect(),
      ctx.db
        .query('mcpConnections')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .collect(),
      ctx.db
        .query('narrativeRuns')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .order('desc')
        .take(8),
    ]);
    const sources = [
      { id: 'checkins', label: 'Reflections and tomorrow intentions', status: 'ready' },
      { id: 'work', label: 'Albatrosses and recorded progress', status: 'ready' },
      { id: 'areas', label: 'Areas and their context', status: 'ready' },
      { id: 'chat', label: 'What you say in chats', status: 'ready' },
      { id: 'documents', label: 'Albatross files', status: 'ready' },
      ...accounts
        .filter((a) => a.status !== 'disconnected')
        .flatMap((a) =>
          ['mail', 'calendar'].map((kind) => ({
            id: `${kind}:${a.accountId}`,
            label: `${kind === 'mail' ? 'Mail' : 'Calendar'} · ${a.email}`,
            status: a.status,
            lastSyncedAt: a.lastSyncedAt,
          })),
        ),
      ...connections
        .filter((c) => c.status !== 'disconnected')
        .map((c) => ({
          id: `mcp:${c.connectionId}`,
          label: c.displayName || c.server,
          status: c.status,
          lastSyncedAt: c.lastSyncedAt,
        })),
    ];
    return {
      settings: prefs
        ? {
            enabled: prefs.enabled,
            sources: prefs.sources,
            timezone: prefs.timezone,
            model: prefs.model,
            revision: prefs.revision,
            lastRunAt: prefs.lastRunAt,
            lastError: prefs.lastError,
            running: (prefs.leaseUntil || 0) > Date.now(),
          }
        : { enabled: false, sources: [], model: 'z-ai/glm-5.3-flash', revision: 0 },
      sources,
      runs,
    };
  },
});

// Configuration is server-only: the Next route enforces the staging pilot gate.
export const configure = mutation({
  args: {
    internalSecret: v.string(),
    userId: v.string(),
    enabled: v.boolean(),
    sources: v.array(v.string()),
    timezone: v.string(),
    model: v.string(),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    new Intl.DateTimeFormat('en', { timeZone: args.timezone });
    if (
      args.sources.length > 40 ||
      args.sources.some(
        (s) => !/^(checkins|work|areas|chat|documents|(?:mail|calendar|mcp):.{1,220})$/.test(s),
      )
    )
      throw new Error('Invalid narrative sources');
    if (!['z-ai/glm-5.3-flash', 'current'].includes(args.model))
      throw new Error('Unsupported narrative model');
    const prev = await settings(ctx, args.userId);
    if (prev?.cleaning) throw new Error('Memory removal is still finishing. Try again shortly.');
    const changed =
      JSON.stringify(prev?.sources) !== JSON.stringify(args.sources) || prev?.enabled !== args.enabled;
    const doc = {
      userId: args.userId,
      enabled: args.enabled,
      sources: [...new Set(args.sources)],
      timezone: args.timezone,
      model: args.model,
      revision: (prev?.revision || 0) + 1,
      updatedAt: Date.now(),
      lease: undefined,
      leaseUntil: undefined,
      refreshToken: undefined,
      refreshScheduledAt: undefined,
    };
    if (prev) await ctx.db.patch(prev._id, doc);
    else await ctx.db.insert('narrativeSettings', { ...doc, createdAt: Date.now() });
    if (changed) {
      await invalidate(ctx, args.userId);
      const cursors = await ctx.db
        .query('narrativeCursors')
        .withIndex('by_user', (q) => q.eq('userId', args.userId))
        .collect();
      for (const cursor of cursors) await ctx.db.delete(cursor._id);
    }
    return { ok: true };
  },
});

export const search = query({
  args: {
    ...caller,
    query: v.optional(v.string()),
    topic: v.optional(v.string()),
    level: v.optional(narrativeLevel),
    from: v.optional(v.number()),
    to: v.optional(v.number()),
    changedSince: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await owner(ctx, args),
      prefs = await settings(ctx, userId);
    if (!prefs?.enabled)
      return {
        entries: [],
        enabled: false,
        revision: prefs?.revision || 0,
        coverage: 'Narrative memory is off.',
      };
    const limit = Math.max(1, Math.min(args.limit || 20, 40));
    const recent =
      args.changedSince !== undefined
        ? await ctx.db
            .query('narrativeEntries')
            .withIndex('by_user_updated', (q) => q.eq('userId', userId).gte('updatedAt', args.changedSince!))
            .order('desc')
            .take(200)
        : args.level
          ? await ctx.db
              .query('narrativeEntries')
              .withIndex('by_user_level_time', (q) =>
                q
                  .eq('userId', userId)
                  .eq('level', args.level!)
                  .gte('occurredAt', args.from ?? 0)
                  .lte('occurredAt', args.to ?? Date.now()),
              )
              .order('desc')
              .take(200)
          : await ctx.db
              .query('narrativeEntries')
              .withIndex('by_user_current_time', (q) =>
                q
                  .eq('userId', userId)
                  .eq('current', true)
                  .gte('occurredAt', args.from ?? 0)
                  .lte('occurredAt', args.to ?? Date.now()),
              )
              .order('desc')
              .take(200);
    const matches = args.query?.trim()
      ? await ctx.db
          .query('narrativeEntries')
          .withSearchIndex('by_text', (q) =>
            q.search('text', args.query!.slice(0, 300)).eq('userId', userId).eq('current', true),
          )
          .take(80)
      : [];
    const pinned = await ctx.db
      .query('narrativeEntries')
      .withIndex('by_user_level_pinned', (q) =>
        q.eq('userId', userId).eq('level', 'observation').eq('pinned', true),
      )
      .order('desc')
      .take(80);
    const candidates = [
      ...new Map([...matches, ...recent, ...pinned].map((r) => [r._id, r])).values(),
    ].filter(
      (r) =>
        r.current &&
        (!args.level || r.level === args.level) &&
        (!args.topic || r.topics.includes(args.topic)) &&
        r.occurredAt >= (args.from ?? 0) &&
        r.occurredAt <= (args.to ?? Infinity) &&
        r.updatedAt >= (args.changedSince ?? 0),
    );
    const entries = [];
    for (const row of rankNarrative(candidates as NarrativeEntry[], args.query || '')) {
      if (await visible(ctx, row, prefs)) entries.push(row);
      if (entries.length >= limit) break;
    }
    return {
      entries,
      enabled: true,
      revision: prefs.revision,
      coverage: 'Bounded indexed retrieval from opted-in sources. Empty results do not prove inactivity.',
      lastRunAt: prefs.lastRunAt,
    };
  },
});

export const read = query({
  args: { ...caller, id: v.string(), sources: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const userId = await owner(ctx, args),
      prefs = await settings(ctx, userId);
    const id = ctx.db.normalizeId('narrativeEntries', args.id);
    if (!id) return null;
    const row = await ctx.db.get(id);
    if (!(await visible(ctx, row, prefs))) return null;
    const sources: any[] = [];
    for (const id of row!.level === 'observation' ? [String(row!._id)] : row!.sourceIds) {
      const evidence: any = await ctx.db.get(id as any);
      if (!(await visible(ctx, evidence, prefs))) continue;
      let detail: any = null;
      if (args.sources && evidence.sourceTable && evidence.sourceId) {
        const original: any = await ctx.db.get(evidence.sourceId as any);
        if (original?.userId === userId) {
          detail = {
            title: original.title || original.subject || original.name,
            text: cleanNarrativeText(
              original.summary ||
                original.description ||
                original.rawText ||
                original.textBody ||
                original.snippet ||
                '',
              12_000,
            ),
            updatedAt: original.updatedAt,
          };
          if (evidence.sourceTable === 'mailCorpusThreads') {
            const messages = await ctx.db
              .query('mailCorpusMessages')
              .withIndex('by_user_account_thread_received', (q) =>
                q
                  .eq('userId', userId)
                  .eq('accountId', original.accountId)
                  .eq('providerThreadId', original.providerThreadId),
              )
              .order('desc')
              .take(12);
            detail.messages = messages.map((m) => ({
              from: m.from,
              at: m.receivedAt,
              text: cleanNarrativeText(m.textBody || m.snippet, 2_000),
            }));
          }
          if (evidence.sourceTable === 'mcpItems') {
            const raw = original.raw || {};
            const expanded = [original.summary, raw.notes, raw.body, raw.content, raw.description].filter(
              (value) => typeof value === 'string',
            );
            detail.text = cleanNarrativeText([...new Set(expanded)].join('\n'), 12_000);
            const connection = await ctx.db
              .query('mcpConnections')
              .withIndex('by_user_connection', (q) =>
                q.eq('userId', userId).eq('connectionId', original.connectionId),
              )
              .unique();
            detail.sync = {
              status: connection?.status,
              lastSyncedAt: connection?.lastSyncedAt,
              completeness:
                'Indexed source content, not a guarantee of a full transcript or live provider state.',
            };
          }
          if (/^(mail|calendar):/.test(evidence.source)) {
            const account = await ctx.db
              .query('connectedAccounts')
              .withIndex('by_user_account', (q) =>
                q.eq('userId', userId).eq('accountId', evidence.accountId || original.accountId),
              )
              .unique();
            detail.sync = {
              status: account?.status,
              lastSyncedAt: account?.lastSyncedAt,
              completeness: 'Synced snapshot; verify current details with the provider.',
            };
          }
          if (evidence.sourceTable === 'documents')
            detail.text = cleanNarrativeText(JSON.stringify(original.model), 12_000);
        }
      }
      sources.push({ ...evidence, ...(args.sources ? { detail, sourceAvailable: Boolean(detail) } : {}) });
    }
    return { entry: row, sources, revision: prefs!.revision };
  },
});

async function putObservation(ctx: MutationCtx, userId: string, value: Observation) {
  const excluded = await ctx.db
    .query('narrativeExclusions')
    .withIndex('by_user_key', (q) => q.eq('userId', userId).eq('key', value.key))
    .unique();
  if (excluded) return false;
  const current = await ctx.db
    .query('narrativeEntries')
    .withIndex('by_user_key_current', (q) => q.eq('userId', userId).eq('key', value.key).eq('current', true))
    .unique();
  if (current?.sourceVersion === value.sourceVersion) return false;
  if (current?.corrected) {
    if (!current.sourceBaseVersion) {
      // Older corrections and captured chat turns may have no source baseline.
      // Establish one without overwriting the correction on this ambiguous
      // first sync. Subsequent genuine source changes can advance the account.
      await ctx.db.patch(current._id, { sourceBaseVersion: value.sourceVersion });
      return false;
    }
    if (current.sourceBaseVersion === value.sourceVersion) return false;
  }
  if (current) await ctx.db.patch(current._id, { current: false, pinned: false, updatedAt: Date.now() });
  await ctx.db.insert('narrativeEntries', {
    ...value,
    userId,
    level: 'observation',
    sourceIds: [],
    current: true,
    observedAt: Date.now(),
    updatedAt: Date.now(),
  });
  return true;
}

/** Coalesce a burst of changes into one durable refresh. The observations are
 * already queryable; the model is never on the critical path of an action. */
async function queueRefresh(ctx: MutationCtx, userId: string) {
  const prefs = await settings(ctx, userId);
  if (!prefs?.enabled || prefs.cleaning) return;
  // A failed scheduler execution must not suppress all later refresh requests.
  if (prefs.refreshToken && (prefs.refreshScheduledAt || 0) + 300_000 > Date.now()) return;
  const at = Math.max(Date.now() + 30_000, (prefs.lastRunAt || 0) + 300_000, (prefs.leaseUntil || 0) + 1000);
  const token = `${Date.now()}:${prefs.revision}`;
  await ctx.db.patch(prefs._id, { refreshToken: token, refreshScheduledAt: at });
  await ctx.scheduler.runAt(at, (internal as any).narrative.flushRefresh, { userId, token });
}

export async function scheduleNarrativeSource(
  ctx: MutationCtx,
  userId: string,
  table: 'aiOperations' | 'albatrossIntents',
  id: string,
) {
  const prefs = await settings(ctx, userId);
  if (!prefs?.enabled || prefs.cleaning) return;
  await ctx.scheduler.runAfter(0, (internal as any).narrative.captureSource, { userId, table, id });
}

// Only internal server mutations can supply source identities. No text supplied
// by a chat/model is accepted as an action receipt.
export const captureSource = internalMutation({
  args: {
    userId: v.string(),
    table: v.union(v.literal('aiOperations'), v.literal('albatrossIntents')),
    id: v.string(),
  },
  handler: async (ctx, args) => {
    const prefs = await settings(ctx, args.userId);
    if (!prefs?.enabled || prefs.cleaning) return { changed: 0 };
    const id = ctx.db.normalizeId(args.table, args.id);
    const row = id ? await ctx.db.get(id) : null;
    if (!row || row.userId !== args.userId) return { changed: 0 };
    let changed = 0;
    for (const item of observationsForRow(args.table, row)) {
      if (await allowed(ctx, args.userId, item.source, prefs))
        changed += Number(await putObservation(ctx, args.userId, item));
    }
    if (changed) {
      await ctx.db.patch(prefs._id, { revision: prefs.revision + 1 });
      await queueRefresh(ctx, args.userId);
    }
    return { changed };
  },
});

export const flushRefresh = internalMutation({
  args: { userId: v.string(), token: v.string() },
  handler: async (ctx, args) => {
    const prefs = await settings(ctx, args.userId);
    if (!prefs?.enabled || prefs.cleaning || prefs.refreshToken !== args.token) return;
    const at = Math.max((prefs.leaseUntil || 0) + 1000, (prefs.lastRunAt || 0) + 300_000);
    if (at > Date.now()) {
      await ctx.db.patch(prefs._id, { refreshScheduledAt: at });
      await ctx.scheduler.runAt(at, (internal as any).narrative.flushRefresh, args);
      return;
    }
    await ctx.db.patch(prefs._id, { refreshToken: undefined, refreshScheduledAt: undefined });
    await ctx.scheduler.runAfter(0, (internal as any).narrative.refreshUser, { userId: args.userId });
  },
});
export const refreshTarget = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => Boolean((await settings(ctx, args.userId))?.enabled),
});
export const refreshUser = internalAction({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const url = process.env.LAB86_MAIL_PUBLIC_URL,
      secret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    if (!url || !secret || !(await ctx.runQuery((internal as any).narrative.refreshTarget, args))) return;
    await fanOutInternalPost(`${url.replace(/\/$/, '')}/api/cron/narrative`, secret, [args], {
      concurrency: 1,
      timeoutMs: 230_000,
      label: 'narrative-change',
    });
  },
});

const groups: Record<
  string,
  { table: string; index: string; kind?: string; prefix: string; timestamp?: 'createdAt' }
> = {
  checkins: { table: 'albatrossDailyCheckins', index: 'by_narrative_updated', prefix: 'checkins' },
  work: { table: 'albatrossIntents', index: 'by_user_updatedAt', prefix: 'work' },
  areas: { table: 'areas', index: 'by_narrative_updated', prefix: 'areas' },
  facts: { table: 'areaFacts', index: 'by_narrative_updated', prefix: 'areas' },
  mail: { table: 'mailCorpusThreads', index: 'by_narrative_updated', prefix: 'mail:' },
  calendar: { table: 'calendarEvents', index: 'by_narrative_updated', prefix: 'calendar:' },
  mcp: { table: 'mcpItems', index: 'by_narrative_updated', prefix: 'mcp:' },
  chat: { table: 'userDocs', index: 'by_user_kind_updatedAt', kind: 'chatSession', prefix: 'chat' },
  documents: { table: 'documents', index: 'by_user_updated', prefix: 'documents' },
  operations: { table: 'aiOperations', index: 'by_narrative_updated', prefix: '' },
  // Pre-rollout receipts have no updatedAt. A separate bounded cursor recovers
  // recent history without rewriting original action logs or missing undo updates.
  operationHistory: {
    table: 'aiOperations',
    index: 'by_user_created',
    prefix: '',
    timestamp: 'createdAt',
  },
};
export const ingest = mutation({
  args: { internalSecret: v.string(), userId: v.string(), group: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const prefs = await settings(ctx, args.userId),
      group = groups[args.group];
    if (!group || !prefs?.enabled || !prefs.sources.some((s) => s.startsWith(group.prefix)))
      return { done: true, changed: 0 };
    const previous = await ctx.db
      .query('narrativeCursors')
      .withIndex('by_user_group', (q) => q.eq('userId', args.userId).eq('group', args.group))
      .unique();
    // Current Work/Area state is relevant even if it predates the history window.
    const since =
      previous?.since ?? (['work', 'areas', 'facts'].includes(args.group) ? 0 : Date.now() - 30 * 86_400_000);
    const until = previous?.cursor ? previous.until : Date.now();
    const query = (ctx.db as any).query(group.table).withIndex(group.index, (q: any) => {
      const index = q.eq('userId', args.userId);
      return (group.kind ? index.eq('kind', group.kind) : index)
        .gte(group.timestamp || 'updatedAt', since)
        .lte(group.timestamp || 'updatedAt', until);
    });
    const page = await query.paginate({ cursor: previous?.cursor || null, numItems: 40 });
    let changed = 0;
    for (const row of page.page)
      for (const item of observationsForRow(group.table, row)) {
        if (prefs.sources.includes('areas')) {
          const kind =
            group.table === 'mailCorpusThreads'
              ? 'mailThread'
              : group.table === 'calendarEvents'
                ? 'calendarEvent'
                : group.table === 'mcpItems'
                  ? 'mcpItem'
                  : null;
          const artifactId = row.providerThreadId || row.providerEventId || row.externalId;
          if (kind && artifactId) {
            const links = await ctx.db
              .query('areaArtifactLinks')
              .withIndex('by_user_artifact', (q) =>
                q.eq('userId', args.userId).eq('artifactKind', kind).eq('artifactId', artifactId),
              )
              .take(8);
            item.topics = [
              ...new Set([
                ...item.topics,
                ...links
                  .filter(
                    (link) =>
                      link.status === 'verified' && (!link.accountId || link.accountId === row.accountId),
                  )
                  .map((link) => `area:${link.areaId}`),
              ]),
            ].slice(0, 40);
            item.sourceVersion += `:${item.topics.join('|')}`;
          }
        }
        if (await allowed(ctx, args.userId, item.source, prefs))
          changed += Number(await putObservation(ctx, args.userId, item));
      }
    const cursorDoc = {
      userId: args.userId,
      group: args.group,
      since: page.isDone ? until : since,
      until,
      cursor: page.isDone ? undefined : page.continueCursor,
      updatedAt: Date.now(),
    };
    if (previous) await ctx.db.patch(previous._id, cursorDoc);
    else await ctx.db.insert('narrativeCursors', cursorDoc);
    if (changed) {
      await ctx.db.patch(prefs._id, { revision: prefs.revision + 1, updatedAt: Date.now() });
    }
    return { done: page.isDone, changed };
  },
});

async function deleteForgottenVersions(ctx: MutationCtx, userId: string, key: string) {
  const page = await ctx.db
    .query('narrativeEntries')
    .withIndex('by_user_key', (q) => q.eq('userId', userId).eq('key', key))
    .take(20);
  for (const row of page) await ctx.db.delete(row._id);
  if (page.length === 20)
    await ctx.scheduler.runAfter(0, internal.narrative.cleanupForgotten, { userId, key });
}

export const cleanupForgotten = internalMutation({
  args: { userId: v.string(), key: v.string() },
  handler: async (ctx, args) => {
    const excluded = await ctx.db
      .query('narrativeExclusions')
      .withIndex('by_user_key', (q) => q.eq('userId', args.userId).eq('key', args.key))
      .unique();
    if (excluded) await deleteForgottenVersions(ctx, args.userId, args.key);
  },
});

export const edit = mutation({
  args: {
    ...caller,
    id: v.id('narrativeEntries'),
    text: v.optional(v.string()),
    forget: v.optional(v.boolean()),
    pinned: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await owner(ctx, args),
      prefs = await settings(ctx, userId),
      row = await ctx.db.get(args.id);
    if (!row || row.userId !== userId || !prefs) throw new Error('Memory not found');
    if (row.level !== 'observation')
      throw new Error('Edit or forget the underlying observations, not their summaries.');
    if (args.forget) {
      if (
        !(await ctx.db
          .query('narrativeExclusions')
          .withIndex('by_user_key', (q) => q.eq('userId', userId).eq('key', row.key))
          .unique())
      )
        await ctx.db.insert('narrativeExclusions', { userId, key: row.key });
      // The exclusion revokes every historical version (and its chapters)
      // immediately; physical deletion makes bounded progress in durable jobs.
      await deleteForgottenVersions(ctx, userId, row.key);
    } else {
      const text = args.text === undefined ? row.text : cleanNarrativeText(args.text);
      if (!text) throw new Error('Memory cannot be empty');
      await ctx.db.patch(row._id, {
        text,
        ...(args.text !== undefined
          ? {
              corrected: true,
              trust: 'reported' as const,
              sourceVersion: `correction:${prefs.revision + 1}`,
              sourceBaseVersion: row.corrected ? row.sourceBaseVersion : row.sourceVersion,
            }
          : {}),
        pinned: args.pinned ?? row.pinned,
        updatedAt: Date.now(),
      });
    }
    await invalidate(ctx, userId);
    await ctx.db.patch(prefs._id, { revision: prefs.revision + 1, updatedAt: Date.now() });
    return { ok: true };
  },
});

export const record = mutation({
  args: {
    internalSecret: v.string(),
    userId: v.string(),
    text: v.string(),
    sourceIds: v.array(v.id('narrativeEntries')),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const prefs = await settings(ctx, args.userId);
    if (!prefs?.enabled || !args.sourceIds.length || args.sourceIds.length > 12)
      throw new Error('Memory requires enabled sources and evidence');
    const sources = [];
    for (const id of args.sourceIds) {
      const row = await ctx.db.get(id);
      if (!row?.current || row.level !== 'observation' || !(await visible(ctx, row, prefs)))
        throw new Error('Invalid memory evidence');
      sources.push(row);
    }
    const text = cleanNarrativeText(args.text);
    if (!text) throw new Error('Memory cannot be empty');
    const key = `interpretation:${[...args.sourceIds].sort().join(':')}`;
    const existing = await ctx.db
      .query('narrativeEntries')
      .withIndex('by_user_key', (q) => q.eq('userId', args.userId).eq('key', key))
      .first();
    const doc = {
      userId: args.userId,
      key,
      level: 'thread' as const,
      source: 'derived',
      title: text.slice(0, 120),
      text,
      sourceIds: args.sourceIds,
      sourceVersions: Object.fromEntries(sources.map((s) => [s._id, s.sourceVersion || ''])),
      topics: [...new Set(sources.flatMap((s) => s.topics))].slice(0, 20),
      trust: 'inferred' as const,
      occurredAt: Math.max(...sources.map((s) => s.occurredAt)),
      observedAt: Date.now(),
      updatedAt: Date.now(),
      current: true,
      pinned: sources.some((s) => s.pinned),
    };
    if (existing) await ctx.db.patch(existing._id, doc);
    else await ctx.db.insert('narrativeEntries', doc);
    await ctx.db.patch(prefs._id, { revision: prefs.revision + 1 });
    await queueRefresh(ctx, args.userId);
    return {
      ok: true,
      trust: 'inferred',
      note: 'Interpretation linked to evidence; not a new confirmed fact.',
    };
  },
});

export const captureTurn = mutation({
  args: {
    internalSecret: v.string(),
    userId: v.string(),
    messageId: v.string(),
    text: v.string(),
    topics: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const prefs = await settings(ctx, args.userId);
    if (!prefs?.enabled || !prefs.sources.includes('chat')) return null;
    const text = cleanNarrativeText(args.text);
    if (!text) return null;
    const key = `turn:${args.messageId.slice(0, 180)}`;
    if (
      await ctx.db
        .query('narrativeExclusions')
        .withIndex('by_user_key', (q) => q.eq('userId', args.userId).eq('key', key))
        .unique()
    )
      return null;
    const existing = await ctx.db
      .query('narrativeEntries')
      .withIndex('by_user_key', (q) => q.eq('userId', args.userId).eq('key', key))
      .first();
    if (existing) return existing._id;
    const id = await ctx.db.insert('narrativeEntries', {
      userId: args.userId,
      key,
      level: 'observation',
      source: 'chat',
      title: text.slice(0, 100),
      text: `You said: ${text}`,
      sourceIds: [],
      topics: args.topics.slice(0, 8),
      trust: 'reported',
      occurredAt: Date.now(),
      observedAt: Date.now(),
      updatedAt: Date.now(),
      current: true,
      pinned: false,
    });
    await ctx.db.patch(prefs._id, { revision: prefs.revision + 1 });
    await queueRefresh(ctx, args.userId);
    return id;
  },
});

const compileBucketArgs = {
  userId: v.string(),
  revision: v.number(),
  key: v.string(),
  level: v.union(v.literal('day'), v.literal('week'), v.literal('month'), v.literal('thread')),
  period: v.string(),
  ids: v.array(v.id('narrativeEntries')),
  truncated: v.boolean(),
};

/** At most 60 candidates and 60 existing sources per transaction. No model work. */
async function writeNarrativeBucket(ctx: MutationCtx, prefs: any, bucket: any) {
  const entries: any[] = [];
  for (const id of bucket.ids.slice(0, 60)) {
    const row = await ctx.db.get(id);
    if (
      row &&
      (row as any).level === 'observation' &&
      (bucket.level !== 'thread' || (row as any).current) &&
      (await visible(ctx, row, prefs))
    )
      entries.push(row);
  }
  if (!entries.length) return;
  const existing = await ctx.db
    .query('narrativeEntries')
    .withIndex('by_user_key', (q) => q.eq('userId', prefs.userId).eq('key', bucket.key))
    .first();
  const ids = entries.map((row) => String(row._id));
  if (
    existing &&
    existing.sourceIds.length <= 60 &&
    ids.every((id) => existing.sourceIds.includes(id)) &&
    (await visible(ctx, existing, prefs))
  )
    return;
  const doc = {
    userId: prefs.userId,
    key: bucket.key,
    level: bucket.level,
    period: bucket.period,
    source: 'derived',
    title:
      bucket.level === 'thread'
        ? entries[0].title
        : `${bucket.level === 'day' ? 'Day' : bucket.level === 'week' ? 'Week of' : 'Month'} · ${bucket.period}`,
    text: fallbackChapter(entries, prefs.timezone),
    sourceIds: ids,
    sourceVersions: Object.fromEntries(entries.map((row) => [row._id, row.sourceVersion || ''])),
    model: undefined,
    topics: [...new Set(entries.flatMap((row) => row.topics))].slice(0, 30) as string[],
    trust: 'inferred' as const,
    occurredAt: Math.max(...entries.map((row) => row.occurredAt)),
    observedAt: Date.now(),
    updatedAt: Date.now(),
    current: true,
    pinned: entries.some((row) => row.pinned),
    coverage: `${entries.length} linked observations; ${bucket.truncated ? 'bounded recent observation window, older evidence remains searchable' : 'indexed observations'}. Display text may be condensed; expand sources for full detail.`,
  };
  if (existing) await ctx.db.patch(existing._id, doc);
  else await ctx.db.insert('narrativeEntries', doc);
}

/** Durable continuation; changes to consent/evidence make old queued work obsolete. */
export const compileBucket = internalMutation({
  args: compileBucketArgs,
  handler: async (ctx, args) => {
    const prefs = await settings(ctx, args.userId);
    if (!prefs?.enabled || prefs.cleaning || prefs.revision !== args.revision) return;
    await writeNarrativeBucket(ctx, prefs, args);
  },
});

export const compile = mutation({
  args: { internalSecret: v.string(), userId: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const prefs = await settings(ctx, args.userId);
    if (!prefs?.enabled) return { count: 0 };
    const recent = await ctx.db
      .query('narrativeEntries')
      .withIndex('by_user_level_time', (q) => q.eq('userId', args.userId).eq('level', 'observation'))
      .order('desc')
      .take(800);
    const pinned = await ctx.db
      .query('narrativeEntries')
      .withIndex('by_user_level_pinned', (q) =>
        q.eq('userId', args.userId).eq('level', 'observation').eq('pinned', true),
      )
      .order('desc')
      .take(160);
    const rows = [
      ...new Map(
        [...recent, ...pinned.filter((row) => row.level === 'observation')].map((row) => [row._id, row]),
      ).values(),
    ];
    const buckets = new Map<
      string,
      { level: 'day' | 'week' | 'month' | 'thread'; period: string; entries: any[] }
    >();
    for (const row of rows) {
      // Only group metadata here. Source visibility is checked in small writes
      // below, never across all 960 candidates and 160 chapters in one transaction.
      const periods = narrativePeriods(row.occurredAt, prefs.timezone);
      const keys = [
        ...Object.entries(periods),
        ...row.topics.filter((t) => row.current && /^(work|area|repo):/.test(t)).map((t) => ['thread', t]),
      ];
      for (const [level, period] of keys) {
        const key = `${level}:${period}`;
        if (!buckets.has(key)) buckets.set(key, { level: level as any, period, entries: [] });
        buckets.get(key)!.entries.push(row);
      }
    }
    for (const [index, [key, bucket]] of [...buckets].slice(0, 160).entries()) {
      const job = {
        userId: args.userId,
        revision: prefs.revision,
        key,
        level: bucket.level,
        period: bucket.period,
        ids: bucket.entries.slice(0, 60).map((row) => row._id),
        truncated: recent.length === 800 || pinned.length === 160,
      };
      // Four immediate buckets stay below 2,000 worst-case range reads (plus
      // two bounded scans). The remaining buckets each get their own transaction.
      if (index < 4) await writeNarrativeBucket(ctx, prefs, job);
      else await ctx.scheduler.runAfter(0, (internal as any).narrative.compileBucket, job);
    }
    return { count: buckets.size };
  },
});

// Older unpolished chapters must not starve behind the latest search results.
export const pending = query({
  args: { internalSecret: v.string(), userId: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const prefs = await settings(ctx, args.userId);
    if (!prefs?.enabled) return { entries: [] };
    const entries = [];
    for (const level of ['month', 'week', 'thread', 'day'] as const) {
      const rows = await ctx.db
        .query('narrativeEntries')
        .withIndex('by_user_level_model_time', (q) =>
          q.eq('userId', args.userId).eq('level', level).eq('model', undefined),
        )
        .order('asc')
        .take(4);
      for (const row of rows) if (await visible(ctx, row, prefs)) entries.push(row);
    }
    return { entries };
  },
});

export const publish = mutation({
  args: {
    internalSecret: v.string(),
    userId: v.string(),
    revision: v.number(),
    id: v.id('narrativeEntries'),
    text: v.string(),
    model: v.string(),
    sourceIds: v.optional(v.array(v.id('narrativeEntries'))),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const prefs = await settings(ctx, args.userId),
      row = await ctx.db.get(args.id);
    if (
      prefs?.revision !== args.revision ||
      !row ||
      row.level === 'observation' ||
      !(await visible(ctx, row, prefs))
    )
      return { published: false };
    const sourceIds = [...new Set([...row.sourceIds, ...(args.sourceIds || [])])];
    if (sourceIds.length > 80) return { published: false };
    const sourceVersions: Record<string, string> = {};
    for (const id of sourceIds) {
      const source: any = await ctx.db.get(id as any);
      if (!source || source.level !== 'observation' || !(await visible(ctx, source, prefs)))
        return { published: false };
      if ((row.level === 'thread' || row.key.startsWith('brief:')) && !source.current)
        return { published: false };
      sourceVersions[id] = source.sourceVersion || '';
    }
    await ctx.db.patch(row._id, {
      text: cleanNarrativeProse(args.text),
      sourceIds,
      sourceVersions,
      model: args.model,
      updatedAt: Date.now(),
    });
    return { published: true };
  },
});

export const prepareBrief = mutation({
  args: { internalSecret: v.string(), userId: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const prefs = await settings(ctx, args.userId);
    if (!prefs?.enabled) return null;
    const recent = await ctx.db
      .query('narrativeEntries')
      .withIndex('by_user_level_time', (q) => q.eq('userId', args.userId).eq('level', 'observation'))
      .order('desc')
      .take(160);
    const pinned = await ctx.db
      .query('narrativeEntries')
      .withIndex('by_user_level_pinned', (q) =>
        q.eq('userId', args.userId).eq('level', 'observation').eq('pinned', true),
      )
      .order('desc')
      .take(80);
    const checkins = await ctx.db
      .query('narrativeEntries')
      .withIndex('by_user_source', (q) => q.eq('userId', args.userId).eq('source', 'checkins'))
      .order('desc')
      .take(12);
    const sourceHeads = (
      await Promise.all(
        prefs.sources.map((source) =>
          ctx.db
            .query('narrativeEntries')
            .withIndex('by_user_source', (q) => q.eq('userId', args.userId).eq('source', source))
            .order('desc')
            .take(6),
        ),
      )
    ).flat();
    const all = [
      ...new Map([...checkins, ...pinned, ...recent, ...sourceHeads].map((r) => [r._id, r])).values(),
    ].filter((r) => r.level === 'observation' && r.current);
    const eligible = [];
    for (const row of all) {
      if (await visible(ctx, row, prefs)) eligible.push(row);
    }
    const selected = selectBriefEvidence(eligible);
    if (!selected.length) return null;
    const day = narrativePeriods(Date.now(), prefs.timezone).day,
      key = `brief:${day}`;
    const existing = await ctx.db
      .query('narrativeEntries')
      .withIndex('by_user_key', (q) => q.eq('userId', args.userId).eq('key', key))
      .first();
    const sourceIds = selected.map((row) => String(row._id));
    if (
      existing &&
      sourceIds.every((id) => existing.sourceIds.includes(id)) &&
      (await visible(ctx, existing, prefs))
    )
      return existing._id;
    const doc = {
      userId: args.userId,
      key,
      level: 'day' as const,
      period: day,
      title: 'Your day in context',
      text: fallbackChapter(selected, prefs.timezone),
      source: 'derived',
      sourceIds,
      sourceVersions: Object.fromEntries(selected.map((r) => [r._id, r.sourceVersion || ''])),
      topics: [...new Set(selected.flatMap((row) => row.topics))].slice(0, 30),
      trust: 'inferred' as const,
      occurredAt: Date.now(),
      observedAt: Date.now(),
      updatedAt: Date.now(),
      current: true,
      pinned: false,
      model: undefined,
      coverage: `${selected.length} observations from selected sources; recorded history and open Work. Verify time-sensitive details at their source.`,
    };
    if (existing) {
      await ctx.db.patch(existing._id, doc);
      return existing._id;
    }
    return ctx.db.insert('narrativeEntries', doc);
  },
});

export const brief = query({
  args: { ...caller, at: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await owner(ctx, args),
      prefs = await settings(ctx, userId);
    if (!prefs?.enabled) return { enabled: false, entry: null };
    const key = `brief:${narrativePeriods(args.at || Date.now(), prefs.timezone).day}`;
    const entry = await ctx.db
      .query('narrativeEntries')
      .withIndex('by_user_key', (q) => q.eq('userId', userId).eq('key', key))
      .first();
    return {
      enabled: true,
      entry: (await visible(ctx, entry, prefs)) ? entry : null,
      lastError: prefs.lastError,
      running: (prefs.leaseUntil || 0) > Date.now(),
    };
  },
});

export const claim = mutation({
  args: { internalSecret: v.string(), userId: v.string(), runId: v.string(), kind: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const prefs = await settings(ctx, args.userId),
      now = Date.now();
    if (!prefs?.enabled || prefs.cleaning || (prefs.leaseUntil || 0) > now) return null;
    const date = new Date(now).toISOString().slice(0, 10),
      runs = prefs.dailyRunDate === date ? prefs.dailyRuns || 0 : 0;
    if (runs >= 24) return null;
    await ctx.db.patch(prefs._id, {
      lease: args.runId,
      leaseUntil: now + 240_000,
      dailyRunDate: date,
      dailyRuns: runs + 1,
    });
    await ctx.db.insert('narrativeRuns', {
      userId: args.userId,
      runId: args.runId,
      kind: args.kind,
      status: 'running',
      startedAt: now,
    });
    return { ...prefs, groups: Object.keys(groups) };
  },
});
export const finish = mutation({
  args: {
    internalSecret: v.string(),
    userId: v.string(),
    runId: v.string(),
    error: v.optional(v.string()),
    model: v.optional(v.string()),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    sourceCount: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const prefs = await settings(ctx, args.userId);
    const run = await ctx.db
      .query('narrativeRuns')
      .withIndex('by_user_run', (q) => q.eq('userId', args.userId).eq('runId', args.runId))
      .unique();
    if (run)
      await ctx.db.patch(run._id, {
        status: args.error ? 'partial' : 'ready',
        endedAt: Date.now(),
        error: args.error?.slice(0, 400),
        model: args.model,
        inputTokens: args.inputTokens,
        outputTokens: args.outputTokens,
        sourceCount: args.sourceCount,
      });
    if (prefs?.lease === args.runId)
      await ctx.db.patch(prefs._id, {
        lease: undefined,
        leaseUntil: undefined,
        lastRunAt: Date.now(),
        lastError: args.error?.slice(0, 400),
      });
  },
});

export const cleanup = internalMutation({
  args: {
    userId: v.string(),
    derivedOnly: v.optional(v.boolean()),
    all: v.optional(v.boolean()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const prefs = await settings(ctx, args.userId);
    const page = await ctx.db
      .query('narrativeEntries')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .paginate({ cursor: args.cursor || null, numItems: 20 });
    for (const row of page.page)
      if (args.all || (args.derivedOnly ? row.level !== 'observation' : !(await visible(ctx, row, prefs))))
        await ctx.db.delete(row._id);
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, (internal as any).narrative.cleanup, {
        ...args,
        cursor: page.continueCursor,
      });
    else if (args.all && prefs?.cleaning) {
      // Keep only source-key opt-out tombstones, never forgotten content. An
      // explicit forget must survive erasure and later source re-enablement.
      for (const table of ['narrativeCursors', 'narrativeRuns'] as const) {
        const remaining = await ctx.db
          .query(table)
          .withIndex('by_user', (q) => q.eq('userId', args.userId))
          .take(200);
        for (const item of remaining) await ctx.db.delete(item._id);
        if (remaining.length === 200) {
          await ctx.scheduler.runAfter(0, (internal as any).narrative.cleanup, {
            userId: args.userId,
            all: true,
          });
          return;
        }
      }
      await ctx.db.patch(prefs._id, { cleaning: false, lastError: undefined, lastRunAt: undefined });
    }
  },
});
export const erase = mutation({
  args: caller,
  handler: async (ctx, args) => {
    const userId = await owner(ctx, args),
      prefs = await settings(ctx, userId);
    if (prefs)
      await ctx.db.patch(prefs._id, {
        enabled: false,
        sources: [],
        revision: prefs.revision + 1,
        lease: undefined,
        leaseUntil: undefined,
        lastError: undefined,
        cleaning: true,
        refreshToken: undefined,
        refreshScheduledAt: undefined,
      });
    await ctx.scheduler.runAfter(0, (internal as any).narrative.cleanup, { userId, all: true });
    return {
      ok: true,
      note: 'Memory is inaccessible immediately; stored copies are being removed. Source opt-outs are retained so forgotten items do not return. Original source data is unchanged.',
    };
  },
});
export const targets = internalMutation({
  args: {},
  handler: async (ctx) => {
    const selected = await ctx.db
      .query('narrativeSettings')
      .withIndex('by_enabled_dispatched', (q) => q.eq('enabled', true))
      .take(100);
    for (const prefs of selected) await ctx.db.patch(prefs._id, { lastDispatchedAt: Date.now() });
    return selected.map((prefs) => prefs.userId);
  },
});
export const tick = internalAction({
  args: {},
  handler: async (ctx) => {
    const url = process.env.LAB86_MAIL_PUBLIC_URL,
      secret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    if (!url || !secret) return;
    const users: string[] = await ctx.runMutation(internal.narrative.targets, {});
    await fanOutInternalPost(
      `${url.replace(/\/$/, '')}/api/cron/narrative`,
      secret,
      users.map((userId) => ({ userId })),
      { concurrency: 2, timeoutMs: 230_000, label: 'narrative' },
    );
  },
});
