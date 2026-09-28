import { v } from 'convex/values';
import { contentChunks, contentLabelsSchema, MAX_CONTENT_CHARS } from '../lib/content/contract';
import { truncateText } from '../lib/shared/text';
import { internal } from './_generated/api';
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from './_generated/server';
import { documentModel } from './documents';
import { fanOutInternalPost, requireInternalSecret } from './lib';
import { readThreadBodies, resolvedBody } from './mailBodies';

const caller = { internalSecret: v.optional(v.string()), userId: v.string() };
export async function contentPreferences(ctx: any, userId: string) {
  const row = await ctx.db
    .query('userDocs')
    .withIndex('by_user_kind_key', (q: any) =>
      q.eq('userId', userId).eq('kind', 'contentPreferences').eq('key', 'default'),
    )
    .unique();
  return { enabled: row?.doc?.enabled !== false, prepare: row?.doc?.prepare !== false };
}
export async function contentAccess(ctx: any, userId: string, item: any, purpose = 'search') {
  if (!item || item.userId !== userId || item.deleted) return false;
  if (item.source === 'document') {
    const doc = await ctx.db
      .query('documents')
      .withIndex('by_user_document', (q: any) => q.eq('userId', userId).eq('documentId', item.externalId))
      .unique();
    return Boolean(doc && !doc.archivedAt);
  }
  const table = ['mail', 'attachment'].includes(item.source)
    ? 'connectedAccounts'
    : ['google_drive', 'onedrive'].includes(item.source)
      ? 'cloudFileConnections'
      : 'mcpConnections';
  const account = table === 'connectedAccounts';
  const connection = await ctx.db
    .query(table)
    .withIndex(account ? 'by_user_account' : 'by_user_connection', (q: any) =>
      q.eq('userId', userId).eq(account ? 'accountId' : 'connectionId', item.connectionId),
    )
    .unique();
  // A connector sync error keeps its indexed items readable; only a disconnect hides them.
  const readable =
    table === 'mcpConnections' ? connection?.status !== 'disconnected' : connection?.status === 'connected';
  if (!connection || !readable) return false;
  if (
    table === 'mcpConnections' &&
    !(purpose === 'brief' ? connection.includeInBrief : connection.includeInSearch)
  )
    return false;
  if (item.source === 'attachment') {
    let ids: string[];
    try {
      ids = JSON.parse(item.externalId);
    } catch {
      return false;
    }
    if (!Array.isArray(ids) || ids.length !== 2 || ids.some((id) => typeof id !== 'string' || !id))
      return false;
    const message = await ctx.db
      .query('mailCorpusMessages')
      .withIndex('by_account_message', (q: any) =>
        q.eq('accountId', item.connectionId).eq('providerMessageId', ids[0]),
      )
      .unique();
    if (
      !message ||
      message.userId !== userId ||
      !(message.attachments || []).some((a: any) => (a.attachmentId || a.id) === ids[1]) ||
      message.labels.some((label: string) => ['TRASH', 'SPAM'].includes(label.toUpperCase()))
    )
      return false;
  } else if (account) {
    const thread = await ctx.db
      .query('mailCorpusThreads')
      .withIndex('by_user_account_thread', (q: any) =>
        q.eq('userId', userId).eq('accountId', item.connectionId).eq('providerThreadId', item.externalId),
      )
      .unique();
    if (!thread || thread.labels.some((label: string) => ['TRASH', 'SPAM'].includes(label.toUpperCase())))
      return false;
  }
  if (table === 'mcpConnections') {
    const original = await ctx.db
      .query('mcpItems')
      .withIndex('by_connection_external', (q: any) =>
        q.eq('connectionId', item.connectionId).eq('externalId', item.externalId),
      )
      .unique();
    if (!original || original.userId !== userId) return false;
  }
  const sync = await syncRow(ctx, userId, item.connectionId);
  return sync?.status !== 'access_lost';
}
async function syncRow(ctx: any, userId: string, connectionId: string) {
  return ctx.db
    .query('contentSync')
    .withIndex('by_user_connection', (q: any) => q.eq('userId', userId).eq('connectionId', connectionId))
    .unique();
}
export const settings = query({
  args: caller,
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const rows = await ctx.db
      .query('contentSync')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .collect();
    const recent = await ctx.db
      .query('contentItems')
      .withIndex('by_user_updated', (q) => q.eq('userId', args.userId))
      .order('desc')
      .take(50);
    const connections = await Promise.all(
      rows.map(async ({ lease: _lease, cursor: _cursor, ...row }) => {
        const id = row.connectionId.replace(/^__history:/, '');
        const cloud = await ctx.db
          .query('cloudFileConnections')
          .withIndex('by_user_connection', (q) => q.eq('userId', args.userId).eq('connectionId', id))
          .unique();
        const mcp = cloud
          ? null
          : await ctx.db
              .query('mcpConnections')
              .withIndex('by_user_connection', (q) => q.eq('userId', args.userId).eq('connectionId', id))
              .unique();
        const displayName = cloud
          ? `${cloud.provider === 'google_drive' ? 'Google Drive' : 'OneDrive'}${cloud.accountEmail ? ` · ${cloud.accountEmail}` : ''}`
          : mcp?.displayName || mcp?.server;
        return { ...row, displayName };
      }),
    );
    return {
      preferences: await contentPreferences(ctx, args.userId),
      connections,
      sampleSize: recent.length,
      counts: {
        indexed: recent.filter((r) => !r.deleted).length,
        classified: recent.filter((r) => !r.deleted && r.labels).length,
        pending: recent.filter((r) => !r.deleted && r.status === 'pending').length,
        partial: recent.filter((r) => !r.deleted && r.partial).length,
        semantic: recent.filter((r) => !r.deleted && r.embeddingVersion === r.version).length,
      },
    };
  },
});
export const savePreferences = mutation({
  args: { ...caller, enabled: v.boolean(), prepare: v.boolean() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ctx.db
      .query('userDocs')
      .withIndex('by_user_kind_key', (q) =>
        q.eq('userId', args.userId).eq('kind', 'contentPreferences').eq('key', 'default'),
      )
      .unique();
    const doc = { enabled: args.enabled, prepare: args.prepare };
    if (row) await ctx.db.patch(row._id, { doc, updatedAt: Date.now() });
    else
      await ctx.db.insert('userDocs', {
        userId: args.userId,
        kind: 'contentPreferences',
        key: 'default',
        doc,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
  },
});
export const claimSync = mutation({
  args: { ...caller, connectionId: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    if (!(await contentPreferences(ctx, args.userId)).enabled) return null;
    const row = await syncRow(ctx, args.userId, args.connectionId);
    if ((row?.leaseUntil || 0) > Date.now()) return null;
    const lease = crypto.randomUUID();
    const patch = {
      lease,
      leaseUntil: Date.now() + (args.connectionId === '__cycle' ? 900_000 : 360_000),
      updatedAt: Date.now(),
    };
    if (row) await ctx.db.patch(row._id, patch);
    else
      await ctx.db.insert('contentSync', {
        userId: args.userId,
        connectionId: args.connectionId,
        status: 'syncing',
        indexed: 0,
        skipped: 0,
        ...patch,
      });
    return { lease, cursor: row?.cursor };
  },
});
export const finishSync = mutation({
  args: {
    ...caller,
    connectionId: v.string(),
    lease: v.string(),
    cursor: v.optional(v.any()),
    indexed: v.number(),
    skipped: v.number(),
    status: v.string(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await syncRow(ctx, args.userId, args.connectionId);
    if (!row || row.lease !== args.lease) return false;
    await ctx.db.patch(row._id, {
      cursor: args.cursor === undefined ? row.cursor : args.cursor,
      indexed: row.indexed + args.indexed,
      skipped: row.skipped + args.skipped,
      status: args.status,
      error: args.error,
      lease: undefined,
      leaseUntil: undefined,
      updatedAt: Date.now(),
    });
    return true;
  },
});
export const upsert = mutation({
  args: { ...caller, items: v.array(v.any()) },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    if (args.items.length > 50) throw new Error('Content batch too large.');
    let changed = 0;
    for (const input of args.items) {
      const key = `${input.source}:${input.connectionId}:${input.externalId}`;
      const row = await ctx.db
        .query('contentItems')
        .withIndex('by_user_key', (q) => q.eq('userId', args.userId).eq('key', key))
        .unique();
      if (row?.version === input.version && row?.deleted === Boolean(input.deleted)) continue;
      const patch = {
        userId: args.userId,
        key,
        source: String(input.source),
        connectionId: String(input.connectionId),
        externalId: String(input.externalId),
        title: truncateText(String(input.title), 500),
        text: input.deleted ? '' : truncateText(String(input.text ?? ''), MAX_CONTENT_CHARS),
        url: input.url,
        version: String(input.version),
        modifiedAt: Number(input.modifiedAt),
        indexedAt: Date.now(),
        partial: Boolean(input.partial || String(input.text ?? '').length > MAX_CONTENT_CHARS),
        deleted: Boolean(input.deleted),
        labels: undefined,
        status: input.deleted ? 'deleted' : 'pending',
        attempts: 0,
        nextAttemptAt: 0,
        lease: undefined,
        leaseUntil: undefined,
        embeddingVersion: undefined,
      };
      if (row) {
        await ctx.db.patch(row._id, patch);
        const chunks = await ctx.db
          .query('contentChunks')
          .withIndex('by_item', (q) => q.eq('itemId', row._id))
          .collect();
        for (const chunk of chunks) await ctx.db.delete(chunk._id);
        const proposals = await ctx.db
          .query('briefPreparations')
          .withIndex('by_user_status', (q) => q.eq('userId', args.userId).eq('status', 'pending'))
          .take(50);
        for (const proposal of proposals)
          if (proposal.seedId === row._id || proposal.sources.some((s: any) => s._id === row._id))
            await ctx.db.patch(proposal._id, { needsRefresh: true, updatedAt: Date.now() });
      } else await ctx.db.insert('contentItems', patch);
      changed++;
    }
    return { changed };
  },
});
/** Reconcile a completed provider census in small transactions. Never remove
 * unseen files until every listing page has been successfully processed. */
export const reconcileScan = mutation({
  args: {
    ...caller,
    connectionId: v.string(),
    lease: v.string(),
    generation: v.string(),
    keys: v.optional(v.array(v.string())),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const sync = await syncRow(ctx, args.userId, args.connectionId);
    if (!sync || sync.lease !== args.lease) throw new Error('Source sync lease changed.');
    if (args.keys) {
      if (args.keys.length > 100) throw new Error('Source page too large.');
      for (const key of args.keys) {
        const row = await ctx.db
          .query('contentItems')
          .withIndex('by_user_key', (q) => q.eq('userId', args.userId).eq('key', key))
          .unique();
        if (row && row.connectionId === args.connectionId)
          await ctx.db.patch(row._id, { scanGeneration: args.generation });
      }
      return { done: false, cursor: null };
    }
    const page = await ctx.db
      .query('contentItems')
      .withIndex('by_user_connection', (q) =>
        q.eq('userId', args.userId).eq('connectionId', args.connectionId),
      )
      .paginate({ cursor: args.cursor || null, numItems: 5 });
    for (const row of page.page) {
      if (row.deleted || row.scanGeneration === args.generation) continue;
      await ctx.db.patch(row._id, {
        deleted: true,
        text: '',
        status: 'deleted',
        labels: undefined,
        embeddingVersion: undefined,
        lease: undefined,
        indexedAt: Date.now(),
      });
      const chunks = await ctx.db
        .query('contentChunks')
        .withIndex('by_item', (q) => q.eq('itemId', row._id))
        .collect();
      for (const chunk of chunks) await ctx.db.delete(chunk._id);
    }
    return { done: page.isDone, cursor: page.isDone ? null : page.continueCursor };
  },
});
export const localPage = query({
  args: {
    ...caller,
    source: v.union(v.literal('mail'), v.literal('mcp'), v.literal('document')),
    cursor: v.optional(v.string()),
    recent: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const table =
      args.source === 'mail' ? 'mailCorpusThreads' : args.source === 'mcp' ? 'mcpItems' : 'documents';
    const page = args.recent
      ? {
          page: await (ctx.db.query(table) as any)
            .withIndex(args.source === 'document' ? 'by_user_updated' : 'by_narrative_updated', (q: any) =>
              q.eq('userId', args.userId),
            )
            .order('desc')
            .take(30),
          isDone: true,
          continueCursor: '',
        }
      : await (ctx.db.query(table) as any)
          .withIndex('by_user', (q: any) => q.eq('userId', args.userId))
          .paginate({ cursor: args.cursor || null, numItems: 20 });
    const items = [];
    const attachments: any[] = [];
    // Mail of an account that is not connected is not read, labelled, or
    // embedded. The cursor still moves past it. One read for each page.
    const liveAccounts =
      args.source === 'mail'
        ? new Set(
            (
              await ctx.db
                .query('connectedAccounts')
                .withIndex('by_user', (q) => q.eq('userId', args.userId))
                .collect()
            )
              .filter((account) => account.status === 'connected')
              .map((account) => account.accountId),
          )
        : null;
    for (const row of page.page) {
      if (liveAccounts && !liveAccounts.has(row.accountId)) continue;
      let text = row.searchText || '';
      let partial = false;
      if (args.source === 'mail') {
        const mail = await mailThreadContent(ctx, args.userId, row);
        text = mail.text;
        partial = mail.partial;
        attachments.push(...mail.attachments);
      } else if (args.source === 'document') text = documentText(await documentModel(ctx, row));
      else {
        text = [
          row.searchText,
          row.raw?.body,
          row.raw?.text,
          row.raw?.description,
          row.raw?.fields?.description ? JSON.stringify(row.raw.fields.description) : '',
          row.raw?.notes ? JSON.stringify(row.raw.notes) : '',
        ]
          .filter(Boolean)
          .join('\n');
      }
      items.push({
        source: args.source === 'mcp' ? row.server : args.source,
        connectionId: row.connectionId || row.accountId || 'library',
        externalId: row.externalId || row.providerThreadId || row.documentId,
        title: row.title || row.subject || '(untitled)',
        text,
        url: row.url,
        modifiedAt: row.updatedAtSource || row.lastDate || row.updatedAt,
        partial,
        deleted: Boolean(row.archivedAt),
        mailAssessment: row.jev,
      });
    }
    return { items, attachments, cursor: page.isDone ? null : page.continueCursor };
  },
});
// The content of one mail thread for the content index: the newest 16
// messages, oldest first, as "from, subject, body". The body comes from the
// body table (IO-1), so the text and its version are the same as before the
// body split.
async function mailThreadContent(ctx: any, userId: string, row: any) {
  const messages = await ctx.db
    .query('mailCorpusMessages')
    .withIndex('by_user_account_thread_received', (q: any) =>
      q.eq('userId', userId).eq('accountId', row.accountId).eq('providerThreadId', row.providerThreadId),
    )
    .order('desc')
    .take(MAIL_CONTENT_MESSAGES + 1);
  const window = messages.slice(0, MAIL_CONTENT_MESSAGES).filter((m: any) => m.userId === userId);
  const bodies = await readThreadBodies(ctx, userId, row.accountId, row.providerThreadId, window);
  let bodyChars = 0;
  const text = [...window]
    .reverse()
    .map((m: any) => {
      const body = resolvedBody(m, bodies.get(m.providerMessageId));
      bodyChars += body.textBody.length + (body.htmlBody?.length ?? 0);
      return `${m.from}\n${m.subject}\n${body.textBody || m.snippet || ''}`;
    })
    .join('\n\n');
  const attachments = [];
  for (const message of window)
    for (const file of message.attachments || [])
      attachments.push({
        connectionId: row.accountId,
        messageId: message.providerMessageId,
        attachmentId: file.attachmentId || file.id,
        filename: file.filename || file.name || 'attachment',
        mimeType: file.mimeType || file.content_type || file.contentType || '',
        size: file.size || 0,
        modifiedAt: message.receivedAt,
      });
  return { text, partial: messages.length > MAIL_CONTENT_MESSAGES, attachments, bodyChars };
}

// Messages of one thread in its content item.
const MAIL_CONTENT_MESSAGES = 16;
// Threads that one change page reads at most.
const MAIL_CHANGES_PAGE = 25;
// A change page stops after about this many characters of body text and
// HTML, far under the 16 MB read limit of a query.
const MAIL_CHANGES_BODY_BUDGET = 4_000_000;

/**
 * The mail threads that changed after a watermark (IO-1, K2). The content
 * cycle used to walk the whole corpus every two minutes. Now it reads only
 * the threads whose row changed after the last pass, oldest change first,
 * through the (userId, updatedAt, _creationTime) order of
 * `by_narrative_updated`. The watermark is the position of the last thread
 * read, so a group of threads with the same updatedAt is never skipped.
 *
 * It skips threads of accounts that are not connected, spam and trash, and
 * mail older than `sinceLastDate`; the watermark still moves past them.
 */
export const mailChanges = query({
  args: {
    ...caller,
    after: v.object({ updatedAt: v.number(), creationTime: v.number() }),
    sinceLastDate: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const limit = Math.min(Math.max(Math.floor(args.limit ?? MAIL_CHANGES_PAGE), 1), 100);
    const tie = await ctx.db
      .query('mailCorpusThreads')
      .withIndex('by_narrative_updated', (q) =>
        q
          .eq('userId', args.userId)
          .eq('updatedAt', args.after.updatedAt)
          .gt('_creationTime', args.after.creationTime),
      )
      .take(limit + 1);
    const newer =
      tie.length > limit
        ? []
        : await ctx.db
            .query('mailCorpusThreads')
            .withIndex('by_narrative_updated', (q) =>
              q.eq('userId', args.userId).gt('updatedAt', args.after.updatedAt),
            )
            .take(limit + 1 - tie.length);
    const rows = [...tie, ...newer];
    const live = new Set(
      (
        await ctx.db
          .query('connectedAccounts')
          .withIndex('by_user', (q) => q.eq('userId', args.userId))
          .collect()
      )
        .filter((account) => account.status === 'connected')
        .map((account) => account.accountId),
    );
    const items = [];
    const attachments: any[] = [];
    let watermark = args.after;
    let budget = MAIL_CHANGES_BODY_BUDGET;
    let read = 0;
    for (const row of rows.slice(0, limit)) {
      if (budget <= 0) break;
      read++;
      watermark = { updatedAt: row.updatedAt, creationTime: row._creationTime };
      if (
        !live.has(row.accountId) ||
        (row.labels || []).some((label: string) => ['TRASH', 'SPAM'].includes(label.toUpperCase())) ||
        (args.sinceLastDate !== undefined && (row.lastDate || 0) < args.sinceLastDate)
      )
        continue;
      const mail = await mailThreadContent(ctx, args.userId, row);
      budget -= mail.bodyChars;
      attachments.push(...mail.attachments);
      items.push({
        source: 'mail',
        connectionId: row.accountId,
        externalId: row.providerThreadId,
        title: row.subject || '(untitled)',
        text: mail.text,
        modifiedAt: row.lastDate || row.updatedAt,
        partial: mail.partial,
        deleted: false,
        mailAssessment: row.jev,
      });
    }
    return { items, attachments, watermark, more: rows.length > read };
  },
});

export const versions = query({
  args: { ...caller, keys: v.array(v.string()) },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    if (args.keys.length > 100) throw new Error('Too many source keys.');
    const pairs = await Promise.all(
      args.keys.map(async (key) => {
        const row = await ctx.db
          .query('contentItems')
          .withIndex('by_user_key', (q) => q.eq('userId', args.userId).eq('key', key))
          .unique();
        return [key, row?.version || null];
      }),
    );
    return Object.fromEntries(pairs);
  },
});
export const preparationSources = query({
  args: { ...caller, ids: v.array(v.id('contentItems')) },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const sources = [];
    for (const id of args.ids.slice(0, 20)) {
      const row = await ctx.db.get(id);
      if (await contentAccess(ctx, args.userId, row, 'brief')) sources.push(row);
    }
    return sources;
  },
});
function documentText(model: any): string {
  if (model?.kind === 'doc') return (model.blocks || []).map((b: any) => b.text || '').join('\n');
  if (model?.kind === 'deck')
    return (model.slides || [])
      .map((s: any) =>
        [s.title, s.notes, ...(s.elements || []).map((e: any) => e.text)].filter(Boolean).join('\n'),
      )
      .join('\n\n');
  return JSON.stringify(model || {});
}
/** Paid passes (labels and vectors) one content version gets before it stops as 'failed'. */
export const CONTENT_MAX_ATTEMPTS = 5;
const HOUR_MS = 3_600_000;

export const claimItems = mutation({
  args: caller,
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    if (!(await contentPreferences(ctx, args.userId)).enabled) return [];
    const rows = await ctx.db
      .query('contentItems')
      .withIndex('by_user_pending', (q) =>
        q.eq('userId', args.userId).eq('status', 'pending').lte('nextAttemptAt', Date.now()),
      )
      .take(16);
    const newest = await ctx.db
      .query('contentItems')
      .withIndex('by_user_status_updated', (q) => q.eq('userId', args.userId).eq('status', 'pending'))
      .order('desc')
      .take(16);
    const priority = newest.filter((row) => row.nextAttemptAt <= Date.now()).slice(0, 8);
    const fair = [...new Map([...priority, ...rows].map((row) => [row._id, row])).values()].slice(0, 16);
    const user = await ctx.db
      .query('users')
      .withIndex('by_clerk_user_id', (q) => q.eq('clerkUserId', args.userId))
      .unique();
    const accounts = await ctx.db
      .query('connectedAccounts')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .collect();
    const ownerIdentities = [
      ...new Set(
        [
          user?.name,
          user?.email,
          ...accounts.filter((a) => a.status === 'connected').map((a) => a.email),
        ].filter((value): value is string => Boolean(value)),
      ),
    ];
    const result = [];
    for (const row of fair) {
      if ((row.leaseUntil || 0) > Date.now()) continue;
      // The pass count is taken at claim time, so a pass that never reports
      // back (a crash, a rejected result) also counts.
      if (row.attempts >= CONTENT_MAX_ATTEMPTS) {
        await ctx.db.patch(row._id, { status: 'failed', lease: undefined, leaseUntil: undefined });
        continue;
      }
      if (
        !(
          (await contentAccess(ctx, args.userId, row, 'brief')) ||
          (await contentAccess(ctx, args.userId, row))
        )
      ) {
        // No model call occurs for an item the user cannot read now (a dead
        // account, spam, a lost connection). The next check waits as long as
        // the item is old, from 1 hour to 1 day, and never stops, so the item
        // comes back when access returns.
        const age = Date.now() - (row.indexedAt || 0);
        await ctx.db.patch(row._id, {
          nextAttemptAt: Date.now() + Math.min(24 * HOUR_MS, Math.max(HOUR_MS, age)),
        });
        continue;
      }
      const lease = crypto.randomUUID();
      await ctx.db.patch(row._id, {
        lease,
        leaseUntil: Date.now() + 120_000,
        nextAttemptAt: Date.now() + 120_000,
        attempts: row.attempts + 1,
      });
      result.push({ ...row, attempts: row.attempts + 1, lease, ownerIdentities });
    }
    return result;
  },
});
export const completeItem = mutation({
  args: {
    ...caller,
    id: v.id('contentItems'),
    version: v.string(),
    lease: v.string(),
    labels: v.optional(v.any()),
    vectors: v.optional(v.array(v.array(v.float64()))),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const row = await ctx.db.get(args.id);
    if (
      !row ||
      row.userId !== args.userId ||
      row.deleted ||
      row.version !== args.version ||
      row.lease !== args.lease
    )
      return false;
    const labels = args.labels ? contentLabelsSchema.parse(args.labels) : row.labels;
    if (args.vectors) {
      const chunks = contentChunks(row.text);
      if (
        chunks.length !== args.vectors.length ||
        args.vectors.some((v) => v.length !== 1536 || v.some((n) => !Number.isFinite(n)))
      )
        throw new Error('Invalid vectors.');
      const old = await ctx.db
        .query('contentChunks')
        .withIndex('by_item', (q) => q.eq('itemId', row._id))
        .collect();
      for (const chunk of old) await ctx.db.delete(chunk._id);
      for (let i = 0; i < chunks.length; i++)
        await ctx.db.insert('contentChunks', {
          userId: args.userId,
          itemId: row._id,
          version: row.version,
          text: chunks[i],
          embedding: args.vectors[i],
        });
    }
    const complete = Boolean(labels && (args.vectors || row.embeddingVersion === row.version));
    // claimItems already counted this pass. An incomplete item waits longer
    // after each pass and stops as 'failed' after CONTENT_MAX_ATTEMPTS, until
    // its content changes (upsert then resets the count).
    const failed = !complete && row.attempts >= CONTENT_MAX_ATTEMPTS;
    await ctx.db.patch(row._id, {
      labels,
      embeddingVersion: args.vectors ? row.version : row.embeddingVersion,
      status: complete ? 'ready' : failed ? 'failed' : 'pending',
      nextAttemptAt: Date.now() + Math.min(HOUR_MS, 30_000 * 2 ** Math.min(Math.max(row.attempts - 1, 0), 7)),
      lease: undefined,
      leaseUntil: undefined,
    });
    return true;
  },
});
export const search = query({
  args: { ...caller, query: v.string(), source: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    if (!args.query.trim()) return [];
    const rows = await ctx.db
      .query('contentItems')
      .withSearchIndex('by_text', (q) => {
        const s = q
          .search('text', truncateText(args.query, 200))
          .eq('userId', args.userId)
          .eq('deleted', false);
        return args.source ? s.eq('source', args.source) : s;
      })
      .take(100);
    const allowed = [];
    for (const row of rows) if (await contentAccess(ctx, args.userId, row)) allowed.push(row);
    return allowed.slice(0, 30);
  },
});
export const vectorRows = internalQuery({
  args: { userId: v.string(), ids: v.array(v.id('contentChunks')) },
  handler: async (ctx, args) => {
    const result = [];
    const seen = new Set();
    for (const id of args.ids) {
      const chunk = await ctx.db.get(id);
      if (!chunk || chunk.userId !== args.userId || seen.has(chunk.itemId)) continue;
      const row = await ctx.db.get(chunk.itemId);
      if (row && row.version === chunk.version && (await contentAccess(ctx, args.userId, row))) {
        result.push({ ...row, matchedText: chunk.text });
        seen.add(chunk.itemId);
      }
    }
    return result;
  },
});
export const semanticSearch = action({
  args: { ...caller, vector: v.array(v.float64()) },
  handler: async (ctx, args): Promise<any> => {
    requireInternalSecret(args.internalSecret);
    if (args.vector.length !== 1536 || args.vector.some((n) => !Number.isFinite(n)))
      throw new Error('Invalid search vector.');
    const matches = await ctx.vectorSearch('contentChunks', 'by_embedding', {
      vector: args.vector,
      limit: 80,
      filter: (q) => q.eq('userId', args.userId),
    });
    return ctx.runQuery(internal.content.vectorRows, {
      userId: args.userId,
      ids: matches.filter((r) => r._score > 0.3).map((r) => r._id),
    });
  },
});
export const workCandidates = query({
  args: caller,
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const rows = await ctx.db
      .query('albatrossIntents')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .order('desc')
      .take(150);
    const proposals = await ctx.db
      .query('briefPreparations')
      .withIndex('by_user_status', (q) => q.eq('userId', args.userId).eq('status', 'pending'))
      .take(10);
    return [
      ...rows
        .filter((r) => !['done', 'archived', 'released'].includes(r.workState || r.status))
        .slice(0, 60)
        .map((r) => ({
          id: String(r._id),
          title: r.title,
          text: truncateText(r.rawText, 1500),
          shape: r.shape,
        })),
      ...proposals
        .filter((p) => p.draft && !p.workId)
        .map((p) => ({
          id: `proposal:${p._id}`,
          title: p.draft.title,
          text: `${p.draft.situation} ${p.draft.recommendation}`,
          shape: p.draft.shape,
        })),
    ];
  },
});
export async function nextConnectedUsers(
  ctx: any,
  source: 'connectedAccounts' | 'mcpConnections' | 'cloudFileConnections',
  cursorKey = source as string,
  pageSize = 50,
) {
  const saved = await ctx.db
    .query('contentSyncCursors')
    .withIndex('by_source', (q: any) => q.eq('source', cursorKey))
    .unique();
  const page = await ctx.db
    .query(source)
    .withIndex('by_status', (q: any) => q.eq('status', 'connected'))
    .paginate({
      cursor: saved?.cursor ?? null,
      numItems: pageSize,
      maximumRowsRead: pageSize,
      maximumBytesRead: 512 * 1024,
    });
  const cursor = page.isDone ? null : page.continueCursor;
  if (saved) await ctx.db.patch(saved._id, { cursor });
  else await ctx.db.insert('contentSyncCursors', { source: cursorKey, cursor });
  return [...new Set<string>(page.page.map((row: any) => row.userId))];
}
export const users = internalMutation({
  args: {
    source: v.union(
      v.literal('connectedAccounts'),
      v.literal('mcpConnections'),
      v.literal('cloudFileConnections'),
    ),
  },
  handler: (ctx, args) => nextConnectedUsers(ctx, args.source),
});
export const tick = internalAction({
  args: {},
  handler: async (ctx) => {
    const url = process.env.LAB86_MAIL_PUBLIC_URL;
    const secret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    if (!url || !secret) return;
    const pages = await Promise.all(
      (['connectedAccounts', 'mcpConnections', 'cloudFileConnections'] as const).map((source) =>
        ctx.runMutation(internal.content.users, { source }),
      ),
    );
    const users = [...new Set(pages.flat())];
    await fanOutInternalPost(
      `${url.replace(/\/$/, '')}/api/cron/content`,
      secret,
      users.map((userId: string) => ({ userId })),
      { label: 'content sync' },
    );
  },
});
