import { v } from 'convex/values';
import {
  ATTACHMENT_STORE_MAX_BYTES,
  ATTACHMENT_STORE_WINDOW_MS,
  messageSkipReason,
  queueableAttachments,
} from '../lib/attachments/store-policy';
import { truncateText } from '../lib/shared/text';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalAction, internalMutation, internalQuery, mutation, query } from './_generated/server';
import { fanOutInternalPost, now, requireInternalSecret } from './lib';

// Mail attachment files in our own encrypted storage (Convex file storage).
// The policy (which files, how long) is in lib/attachments/store-policy.ts.
//
// - New mail enters the queue when the corpus stores it (mailCorpus upsert).
// - The backfill cursor adds the stored mail of the window that the corpus
//   held before the queue existed, one page for each mailbox in each tick.
// - The tick asks the app (/api/cron/mail-attachments) to store a few queued
//   files for each user. The app downloads through the provider path, hashes
//   the bytes, uploads them, and records the row (recordFile).
// - The attachment routes read storage first and store what they fetch.
// - Account removal, user deletion, message deletion, and the dead-account
//   purge delete the rows; the stored file goes with its last row.

/** The most files that one claim gives to the app for one user. */
export const QUEUE_CLAIM_LIMIT = 5;
/** A claimed row comes back after this time if the app does not report. */
export const QUEUE_LEASE_MS = 15 * 60_000;
/** After this many attempts, a transient error becomes permanent. */
export const QUEUE_MAX_ATTEMPTS = 5;
/** A row of a mailbox in `error` waits this long before the next look. */
export const QUEUE_ACCOUNT_WAIT_MS = 6 * 3_600_000;
const QUEUE_RETRY_BASE_MS = 15 * 60_000;
const QUEUE_RETRY_MAX_MS = 24 * 3_600_000;
/** Stored messages that one backfill page reads. */
export const BACKFILL_PAGE = 100;
/** Mailboxes whose backfill moves one page in one tick. */
const BACKFILL_ACCOUNTS_PER_TICK = 20;
/** Live mailboxes that one tick reads. */
const LIVE_ACCOUNTS_READ = 500;
/** Users that one tick asks the app to serve. */
const USERS_PER_TICK = 100;

type Ctx = any;
type FileKey = { userId: string; accountId: string; providerMessageId: string; attachmentId: string };

const caller = { internalSecret: v.optional(v.string()), userId: v.string() };

/** The wait before the next try, after `attempts` failed tries: 15 min, 1 h, 4 h, then 24 h at most. */
export function queueRetryDelay(attempts: number) {
  return Math.min(QUEUE_RETRY_BASE_MS * 4 ** Math.max(0, attempts - 1), QUEUE_RETRY_MAX_MS);
}

/** A hex SHA-256 as base64, the form of `_storage.sha256`. */
export function hexToBase64(hex: string) {
  let binary = '';
  for (let i = 0; i < hex.length; i += 2)
    binary += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16));
  return btoa(binary);
}

function byKey(ctx: Ctx, table: 'mailAttachmentFiles' | 'mailAttachmentQueue', key: FileKey) {
  return ctx.db
    .query(table)
    .withIndex('by_user_account_message', (q: any) =>
      q
        .eq('userId', key.userId)
        .eq('accountId', key.accountId)
        .eq('providerMessageId', key.providerMessageId)
        .eq('attachmentId', key.attachmentId),
    );
}

function byMessage(
  ctx: Ctx,
  table: 'mailAttachmentFiles' | 'mailAttachmentQueue',
  userId: string,
  accountId: string,
  providerMessageId: string,
) {
  return ctx.db
    .query(table)
    .withIndex('by_user_account_message', (q: any) =>
      q.eq('userId', userId).eq('accountId', accountId).eq('providerMessageId', providerMessageId),
    );
}

function accountRow(ctx: Ctx, userId: string, accountId: string): Promise<Doc<'connectedAccounts'> | null> {
  return ctx.db
    .query('connectedAccounts')
    .withIndex('by_user_account', (q: any) => q.eq('userId', userId).eq('accountId', accountId))
    .unique();
}

function corpusMessage(ctx: Ctx, accountId: string, providerMessageId: string) {
  return ctx.db
    .query('mailCorpusMessages')
    .withIndex('by_account_message', (q: any) =>
      q.eq('accountId', accountId).eq('providerMessageId', providerMessageId),
    )
    .first();
}

/** An account of the user by accountId, grant id, or email (the forms that clients send). */
async function resolveAccount(ctx: Ctx, userId: string, ref: string) {
  const direct = await accountRow(ctx, userId, ref);
  if (direct) return direct;
  const needle = ref.trim().toLowerCase();
  if (!needle) return null;
  const rows: Doc<'connectedAccounts'>[] = await ctx.db
    .query('connectedAccounts')
    .withIndex('by_user', (q: any) => q.eq('userId', userId))
    .take(50);
  return rows.find((row) => row.grantId === ref || row.email.toLowerCase() === needle) ?? null;
}

/**
 * Adds the files of one stored message to the queue. It skips files that the
 * policy refuses and files that have a row already. A message with no
 * attachments costs no read. Returns the number of new queue rows.
 */
export async function enqueueMessageAttachments(
  ctx: Ctx,
  scope: { userId: string; accountId: string },
  message: {
    providerMessageId: string;
    receivedAt: number;
    labels?: readonly string[];
    attachments?: unknown;
  },
  ts: number,
) {
  const files = queueableAttachments(
    { ...message, attachments: Array.isArray(message.attachments) ? message.attachments : [] },
    ts,
  );
  let queued = 0;
  for (const file of files) {
    const key = {
      userId: scope.userId,
      accountId: scope.accountId,
      providerMessageId: message.providerMessageId,
      attachmentId: file.attachmentId,
    };
    if (await byKey(ctx, 'mailAttachmentFiles', key).first()) continue;
    if (await byKey(ctx, 'mailAttachmentQueue', key).first()) continue;
    await ctx.db.insert('mailAttachmentQueue', {
      ...key,
      filename: file.filename,
      mimeType: file.mimeType,
      size: file.size,
      receivedAt: message.receivedAt,
      state: 'queued',
      attempts: 0,
      dueAt: ts,
      createdAt: ts,
      updatedAt: ts,
    });
    queued += 1;
  }
  return queued;
}

/**
 * Deletes one file row. The stored file goes too when no other row points at
 * it: rows of one user with the same bytes share one file. A file that is
 * gone already does not stop the caller (a purge chain must not stall).
 */
export async function deleteAttachmentFileRow(
  ctx: Ctx,
  row: { _id: Id<'mailAttachmentFiles'>; storageId: Id<'_storage'> },
) {
  await ctx.db.delete(row._id);
  const other = await ctx.db
    .query('mailAttachmentFiles')
    .withIndex('by_storage', (q: any) => q.eq('storageId', row.storageId))
    .first();
  if (other) return false;
  await ctx.storage.delete(row.storageId).catch(() => undefined);
  return true;
}

/** Deletes the file rows (and unshared files) and queue rows of one message. */
export async function deleteMessageAttachmentData(
  ctx: Ctx,
  userId: string,
  accountId: string,
  providerMessageId: string,
) {
  const files = await byMessage(ctx, 'mailAttachmentFiles', userId, accountId, providerMessageId).take(100);
  for (const row of files) await deleteAttachmentFileRow(ctx, row);
  const queued = await byMessage(ctx, 'mailAttachmentQueue', userId, accountId, providerMessageId).take(100);
  for (const row of queued) await ctx.db.delete(row._id);
  return files.length + queued.length;
}

async function clearQueueRow(ctx: Ctx, key: FileKey) {
  const row = await byKey(ctx, 'mailAttachmentQueue', key).first();
  if (row) await ctx.db.delete(row._id);
}

function attachmentMeta(message: any, attachmentId: string) {
  const hit = (Array.isArray(message.attachments) ? message.attachments : []).find(
    (file: any) => file && (file.attachmentId ?? file.id) === attachmentId,
  );
  return {
    filename: hit ? String(hit.filename || hit.name || 'attachment') : undefined,
    mimeType: hit ? String(hit.mimeType || hit.contentType || hit.content_type || '') : undefined,
    size: hit ? Number(hit.size) || 0 : undefined,
    receivedAt: message.receivedAt as number,
    labels: (message.labels || []) as string[],
  };
}

/**
 * The stored file of one attachment, for the attachment routes. Null when no
 * account of the user matches `account`. `file` is null when nothing is
 * stored; then `corpus` has the stored message metadata, when there is a row.
 * The file URL is a capability: the app reads it and never sends it on.
 */
export const getStoredFile = query({
  args: { ...caller, account: v.string(), providerMessageId: v.string(), attachmentId: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const account = await resolveAccount(ctx, args.userId, args.account);
    if (!account) return null;
    const key = {
      userId: args.userId,
      accountId: account.accountId,
      providerMessageId: args.providerMessageId,
      attachmentId: args.attachmentId,
    };
    const row = await byKey(ctx, 'mailAttachmentFiles', key).first();
    const url = row ? await ctx.storage.getUrl(row.storageId) : null;
    let corpus = null;
    if (!url) {
      const message = await corpusMessage(ctx, account.accountId, args.providerMessageId);
      if (message && message.userId === args.userId) corpus = attachmentMeta(message, args.attachmentId);
    }
    return {
      accountId: account.accountId,
      connected: account.status === 'connected',
      file: row && url ? { url, filename: row.filename, mimeType: row.mimeType, size: row.size } : null,
      corpus,
    };
  },
});

export const uploadUrl = mutation({
  args: { internalSecret: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    return ctx.storage.generateUploadUrl();
  },
});

/**
 * Records a stored file. Without `storageId`, it links the bytes to a file of
 * the same user with the same hash, or answers `upload`. With `storageId`
 * (a new upload), it keeps the upload, or deletes it when a row or a twin
 * exists already. A mailbox that is not live keeps nothing (`skipped`).
 */
export const recordFile = mutation({
  args: {
    ...caller,
    accountId: v.string(),
    providerMessageId: v.string(),
    attachmentId: v.string(),
    filename: v.string(),
    mimeType: v.string(),
    size: v.number(),
    sha256: v.string(),
    storageId: v.optional(v.id('_storage')),
  },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    if (!/^[a-f0-9]{64}$/.test(args.sha256)) throw new Error('A file hash is a hex SHA-256.');
    const upload = args.storageId;
    const dropUpload = async () => {
      if (upload) await ctx.storage.delete(upload).catch(() => undefined);
    };
    const key = {
      userId: args.userId,
      accountId: args.accountId,
      providerMessageId: args.providerMessageId,
      attachmentId: args.attachmentId,
    };
    const account = await accountRow(ctx, args.userId, args.accountId);
    if (!account || account.status !== 'connected') {
      await dropUpload();
      return { status: 'skipped' as const };
    }
    if (args.size > ATTACHMENT_STORE_MAX_BYTES) {
      await dropUpload();
      return { status: 'too_large' as const };
    }
    const existing = await byKey(ctx, 'mailAttachmentFiles', key).first();
    if (existing) {
      if (upload && upload !== existing.storageId) await dropUpload();
      await clearQueueRow(ctx, key);
      return { status: 'stored' as const, deduplicated: true };
    }
    const twin = await ctx.db
      .query('mailAttachmentFiles')
      .withIndex('by_user_sha256', (q) => q.eq('userId', args.userId).eq('sha256', args.sha256))
      .first();
    let storageId = twin?.storageId ?? upload;
    let size = args.size;
    if (twin && upload && upload !== twin.storageId) await dropUpload();
    if (!storageId) return { status: 'upload' as const };
    if (!twin) {
      const meta = await ctx.db.system.get(storageId as Id<'_storage'>);
      if (!meta) throw new Error('The uploaded file is not in storage.');
      if (meta.sha256 && meta.sha256 !== hexToBase64(args.sha256)) {
        await dropUpload();
        throw new Error('The uploaded file does not match its hash.');
      }
      size = meta.size;
      storageId = meta._id;
    }
    await ctx.db.insert('mailAttachmentFiles', {
      ...key,
      filename: truncateText(args.filename, 500) || 'attachment',
      mimeType: truncateText(args.mimeType, 255) || 'application/octet-stream',
      size,
      sha256: args.sha256,
      storageId,
      createdAt: now(),
    });
    await clearQueueRow(ctx, key);
    return { status: 'stored' as const, deduplicated: Boolean(twin) };
  },
});

/**
 * Leases up to `limit` due queue rows of one user and returns them. Rows of a
 * removed mailbox, of mail that left the window or went to spam or trash, of
 * a deleted message, and of a file that is stored already are deleted. Rows
 * of a mailbox in `error` wait. Each lease counts one attempt.
 */
export const claimQueue = mutation({
  args: { ...caller, limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const ts = now();
    const limit = Math.min(Math.max(Math.floor(args.limit ?? QUEUE_CLAIM_LIMIT), 1), 10);
    const rows = await ctx.db
      .query('mailAttachmentQueue')
      .withIndex('by_user_state_due', (q) =>
        q.eq('userId', args.userId).eq('state', 'queued').lte('dueAt', ts),
      )
      .take(limit * 4);
    const accounts = new Map<string, Doc<'connectedAccounts'> | null>();
    const claimed = [];
    for (const row of rows) {
      if (claimed.length >= limit) break;
      if (!accounts.has(row.accountId))
        accounts.set(row.accountId, await accountRow(ctx, row.userId, row.accountId));
      const account = accounts.get(row.accountId);
      if (!account) {
        await ctx.db.delete(row._id);
        continue;
      }
      if (account.status !== 'connected') {
        await ctx.db.patch(row._id, { dueAt: ts + QUEUE_ACCOUNT_WAIT_MS, updatedAt: ts });
        continue;
      }
      const message = await corpusMessage(ctx, row.accountId, row.providerMessageId);
      if (
        !message ||
        message.userId !== row.userId ||
        messageSkipReason(message, ts) ||
        (await byKey(ctx, 'mailAttachmentFiles', row).first())
      ) {
        await ctx.db.delete(row._id);
        continue;
      }
      const attempts = row.attempts + 1;
      await ctx.db.patch(row._id, { attempts, dueAt: ts + QUEUE_LEASE_MS, updatedAt: ts });
      claimed.push({
        queueId: row._id,
        accountId: row.accountId,
        providerMessageId: row.providerMessageId,
        attachmentId: row.attachmentId,
        filename: row.filename,
        mimeType: row.mimeType,
        size: row.size,
        attempts,
      });
    }
    return claimed;
  },
});

/**
 * Records a failed download. A permanent error, or the last allowed attempt,
 * marks the row `failed`, and the queue does not try it again. A transient
 * error waits for the retry delay.
 */
export const failQueueItem = mutation({
  args: { ...caller, queueId: v.string(), permanent: v.boolean(), error: v.string() },
  handler: async (ctx, args) => {
    requireInternalSecret(args.internalSecret);
    const id = ctx.db.normalizeId('mailAttachmentQueue', args.queueId);
    const row = id ? await ctx.db.get(id) : null;
    if (!row || row.userId !== args.userId) return { ok: false as const };
    const ts = now();
    const error = truncateText(args.error, 300);
    if (args.permanent || row.attempts >= QUEUE_MAX_ATTEMPTS) {
      await ctx.db.patch(row._id, { state: 'failed', error, updatedAt: ts });
      return { ok: true as const, state: 'failed' as const };
    }
    await ctx.db.patch(row._id, { dueAt: ts + queueRetryDelay(row.attempts), error, updatedAt: ts });
    return { ok: true as const, state: 'queued' as const };
  },
});

async function liveAccounts(ctx: Ctx): Promise<Doc<'connectedAccounts'>[]> {
  return ctx.db
    .query('connectedAccounts')
    .withIndex('by_status', (q: any) => q.eq('status', 'connected'))
    .take(LIVE_ACCOUNTS_READ);
}

function backfillRow(ctx: Ctx, userId: string, accountId: string) {
  return ctx.db
    .query('mailAttachmentBackfills')
    .withIndex('by_user_account', (q: any) => q.eq('userId', userId).eq('accountId', accountId))
    .unique();
}

/** Live mailboxes whose backfill is not done, at most BACKFILL_ACCOUNTS_PER_TICK. */
export const backfillAccounts = internalQuery({
  args: {},
  handler: async (ctx) => {
    const out: Array<{ userId: string; accountId: string }> = [];
    for (const account of await liveAccounts(ctx)) {
      if (out.length >= BACKFILL_ACCOUNTS_PER_TICK) break;
      const state = await backfillRow(ctx, account.userId, account.accountId);
      if (!state?.doneAt) out.push({ userId: account.userId, accountId: account.accountId });
    }
    return out;
  },
});

/**
 * One backfill page for one mailbox: the next BACKFILL_PAGE stored messages,
 * newest first, go through the queue policy. The page cursor stays in
 * mailAttachmentBackfills. The backfill is done at the first message older
 * than the window, or at the end of the corpus.
 */
export const backfillAccountPage = internalMutation({
  args: { userId: v.string(), accountId: v.string() },
  handler: async (ctx, args) => {
    const account = await accountRow(ctx, args.userId, args.accountId);
    if (!account || account.status !== 'connected') return { done: false, queued: 0 };
    const state = await backfillRow(ctx, args.userId, args.accountId);
    if (state?.doneAt) return { done: true, queued: 0 };
    const ts = now();
    const page = await ctx.db
      .query('mailCorpusMessages')
      .withIndex('by_user_account_received', (q) =>
        q.eq('userId', args.userId).eq('accountId', args.accountId),
      )
      .order('desc')
      .paginate({ cursor: state?.cursor ?? null, numItems: BACKFILL_PAGE });
    let done = page.isDone;
    let queued = 0;
    for (const message of page.page) {
      if (message.receivedAt < ts - ATTACHMENT_STORE_WINDOW_MS) {
        done = true;
        break;
      }
      queued += await enqueueMessageAttachments(ctx, args, message, ts);
    }
    const patch = {
      cursor: done ? undefined : page.continueCursor,
      doneAt: done ? ts : undefined,
      queued: (state?.queued ?? 0) + queued,
      updatedAt: ts,
    };
    if (state) await ctx.db.patch(state._id, patch);
    else await ctx.db.insert('mailAttachmentBackfills', { ...args, ...patch, createdAt: ts });
    return { done, queued };
  },
});

/** Users with a live mailbox and a due queue row, at most USERS_PER_TICK. */
export const usersWithDueWork = internalQuery({
  args: { now: v.number() },
  handler: async (ctx, args) => {
    const users = [...new Set((await liveAccounts(ctx)).map((account) => account.userId))];
    const due: string[] = [];
    for (const userId of users) {
      if (due.length >= USERS_PER_TICK) break;
      const row = await ctx.db
        .query('mailAttachmentQueue')
        .withIndex('by_user_state_due', (q) =>
          q.eq('userId', userId).eq('state', 'queued').lte('dueAt', args.now),
        )
        .first();
      if (row) due.push(userId);
    }
    return due;
  },
});

/**
 * The cron: move each unfinished backfill one page, then ask the app to
 * store the due files of each user. Each user gets at most QUEUE_CLAIM_LIMIT
 * files in one tick, so one large mailbox cannot starve the others.
 */
export const tick = internalAction({
  args: {},
  handler: async (ctx): Promise<{ backfilled: number; queued: number; users: number; started: number }> => {
    const url = process.env.LAB86_MAIL_PUBLIC_URL;
    const secret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    if (!url || !secret) return { backfilled: 0, queued: 0, users: 0, started: 0 };
    const accounts = await ctx.runQuery(internal.mailAttachments.backfillAccounts, {});
    let queued = 0;
    for (const account of accounts)
      queued += (await ctx.runMutation(internal.mailAttachments.backfillAccountPage, account)).queued;
    const users = await ctx.runQuery(internal.mailAttachments.usersWithDueWork, { now: Date.now() });
    const started = users.length
      ? await fanOutInternalPost(
          `${url.replace(/\/$/, '')}/api/cron/mail-attachments`,
          secret,
          users.map((userId: string) => ({ userId })),
          { label: 'mail attachment files', concurrency: 4 },
        )
      : 0;
    return { backfilled: accounts.length, queued, users: users.length, started };
  },
});
