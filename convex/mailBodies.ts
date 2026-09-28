// The body split of the mail corpus (IO-1). See lib/mail/corpus-body.ts.
//
// mailCorpusMessages keeps the small fields. mailCorpusBodies keeps the plain
// text and the HTML. This module owns every read and write of the body table,
// and the one-time migration that moves inline bodies out of the old message
// documents.

import { v } from 'convex/values';
import {
  ABSENT_BODY_PART,
  bodyExcerpt,
  bodyHashHasBody,
  bodyPartHash,
  buildSmallSearchText,
  CORPUS_SNIPPET_MAX_CHARS,
  type CorpusMessageBodyFields,
  capHtmlBody,
  capTextBody,
  isLegacyCorpusMessage,
  joinBodyHash,
  splitBodyHash,
  storedBodyText,
} from '../lib/mail/corpus-body';
import { truncateText } from '../lib/shared/text';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { internalMutation } from './_generated/server';
import { now } from './lib';

export interface MessageBody {
  textBody?: string;
  htmlBody?: string;
}

/** The body document of one message, or null. */
export async function readMessageBody(
  ctx: any,
  userId: string,
  accountId: string,
  providerMessageId: string,
): Promise<Doc<'mailCorpusBodies'> | null> {
  return await ctx.db
    .query('mailCorpusBodies')
    .withIndex('by_user_account_message', (q: any) =>
      q.eq('userId', userId).eq('accountId', accountId).eq('providerMessageId', providerMessageId),
    )
    .first();
}

/**
 * The bodies of some messages of one thread, by provider message id. Each
 * body is one point read, so a long thread never reads a body that the
 * caller does not show. Documents from before the split and messages with no
 * body read nothing.
 */
export async function readThreadBodies(
  ctx: any,
  userId: string,
  accountId: string,
  _providerThreadId: string,
  messages: Array<{ providerMessageId: string } & CorpusMessageBodyFields>,
): Promise<Map<string, Doc<'mailCorpusBodies'>>> {
  const wanted = messages.filter(
    (message) => !isLegacyCorpusMessage(message) && bodyHashHasBody(message.bodyHash),
  );
  const rows = await Promise.all(
    wanted.map((message) => readMessageBody(ctx, userId, accountId, message.providerMessageId)),
  );
  const out = new Map<string, Doc<'mailCorpusBodies'>>();
  for (const row of rows) if (row) out.set(row.providerMessageId, row);
  return out;
}

/**
 * The body of one message for a reader: the body document first, then the
 * inline fields of a document from before the split. `htmlBody` is null when
 * the HTML was never stored (the reader then hydrates it from the provider),
 * and '' when the message has no HTML.
 */
export function resolvedBody(
  message: CorpusMessageBodyFields,
  body: MessageBody | null | undefined,
): { textBody: string; htmlBody: string | null } {
  if (body) return { textBody: body.textBody ?? '', htmlBody: body.htmlBody ?? null };
  return { textBody: message.textBody ?? '', htmlBody: message.htmlBody ?? null };
}

/** Deletes the body document of one message. */
export async function deleteMessageBody(
  ctx: any,
  userId: string,
  accountId: string,
  providerMessageId: string,
) {
  const rows = await ctx.db
    .query('mailCorpusBodies')
    .withIndex('by_user_account_message', (q: any) =>
      q.eq('userId', userId).eq('accountId', accountId).eq('providerMessageId', providerMessageId),
    )
    .take(5);
  for (const row of rows) await ctx.db.delete(row._id);
  return rows.length;
}

/** Deletes the body documents of one thread. */
export async function deleteThreadBodies(
  ctx: any,
  userId: string,
  accountId: string,
  providerThreadId: string,
) {
  const rows = await ctx.db
    .query('mailCorpusBodies')
    .withIndex('by_user_account_thread', (q: any) =>
      q.eq('userId', userId).eq('accountId', accountId).eq('providerThreadId', providerThreadId),
    )
    .collect();
  for (const row of rows) await ctx.db.delete(row._id);
  return rows.length;
}

export interface BodyWriteInput {
  userId: string;
  accountId: string;
  providerMessageId: string;
  providerThreadId: string;
}

export interface BodyPlan {
  /** The new `bodyHash` of the small document. */
  bodyHash: string;
  /** True when the plain text changed (a new or different text). */
  textChanged: boolean;
  /** True when the body document must be written. */
  write: boolean;
  /** The body excerpt for `searchText`, or undefined to keep the stored one. */
  excerpt?: string;
  /** Body fields to write (resolved text and HTML). */
  textBody?: string;
  htmlBody?: string;
}

/**
 * Compares an incoming body with the stored one through the hashes on the
 * small document. It reads no body document. A document from before the
 * split always needs a write, because its inline body must move.
 */
export function planBodyWrite(
  existing: CorpusMessageBodyFields | null | undefined,
  incoming: { textBody?: string; htmlBody?: string },
): BodyPlan {
  const legacy = Boolean(existing) && isLegacyCorpusMessage(existing);
  const stored = legacy
    ? { text: bodyPartHash(existing?.textBody), html: bodyPartHash(existing?.htmlBody) }
    : existing
      ? splitBodyHash(existing.bodyHash)
      : { text: ABSENT_BODY_PART, html: ABSENT_BODY_PART };
  const text = incoming.textBody !== undefined ? capTextBody(incoming.textBody) : undefined;
  const html = incoming.htmlBody !== undefined ? capHtmlBody(incoming.htmlBody) : undefined;
  const next = {
    text: text !== undefined ? bodyPartHash(text) : stored.text,
    html: html !== undefined ? bodyPartHash(html) : stored.html,
  };
  const textChanged = next.text !== stored.text;
  const write = legacy || textChanged || next.html !== stored.html;
  const resolvedText = text ?? (legacy ? (existing?.textBody ?? undefined) : undefined);
  const resolvedHtml = html ?? (legacy ? (existing?.htmlBody ?? undefined) : undefined);
  return {
    bodyHash: joinBodyHash(next),
    textChanged,
    write,
    excerpt:
      resolvedText !== undefined
        ? bodyExcerpt(resolvedText)
        : existing && !legacy
          ? storedBodyText(existing)
          : '',
    textBody: resolvedText,
    htmlBody: resolvedHtml,
  };
}

/**
 * Writes the body document of one message from a plan. A part that the plan
 * does not carry keeps its stored value. With no text and no HTML, no body
 * document stays.
 */
export async function writeMessageBody(ctx: any, input: BodyWriteInput, plan: BodyPlan, ts: number) {
  const row = await readMessageBody(ctx, input.userId, input.accountId, input.providerMessageId);
  const textBody = plan.textBody !== undefined ? plan.textBody : row?.textBody;
  const htmlBody = plan.htmlBody !== undefined ? plan.htmlBody : row?.htmlBody;
  if (textBody === undefined && htmlBody === undefined) {
    if (row) await ctx.db.delete(row._id);
    return;
  }
  const fields = {
    userId: input.userId,
    accountId: input.accountId,
    providerMessageId: input.providerMessageId,
    providerThreadId: input.providerThreadId,
    textBody,
    htmlBody,
    updatedAt: ts,
  };
  if (row) await ctx.db.patch(row._id, fields);
  else await ctx.db.insert('mailCorpusBodies', { ...fields, createdAt: ts });
}

/** Moves a body document to another thread when its message moved. */
export async function moveMessageBody(ctx: any, input: BodyWriteInput, ts: number) {
  const row = await readMessageBody(ctx, input.userId, input.accountId, input.providerMessageId);
  if (row && row.providerThreadId !== input.providerThreadId)
    await ctx.db.patch(row._id, { providerThreadId: input.providerThreadId, updatedAt: ts });
}

/**
 * The small fields that replace the inline body of a document from before
 * the split: the new search text, the excerpt start, the body hash, and the
 * cleared inline fields.
 */
export function splitPatch(doc: Doc<'mailCorpusMessages'>, plan: BodyPlan) {
  const snippet = truncateText(String(doc.snippet ?? ''), CORPUS_SNIPPET_MAX_CHARS);
  const { searchText, excerptAt } = buildSmallSearchText({ ...doc, snippet }, plan.excerpt ?? '');
  return {
    textBody: undefined,
    htmlBody: undefined,
    snippet,
    searchText,
    excerptAt,
    bodyHash: plan.bodyHash,
  };
}

// ---- Migration ----------------------------------------------------------------------

const migrationTotals = v.object({
  accounts: v.number(),
  scanned: v.number(),
  split: v.number(),
  bodies: v.number(),
  alreadySplit: v.number(),
  // Characters of text and HTML that moved to mailCorpusBodies.
  movedChars: v.number(),
});
type MigrationTotals = typeof migrationTotals.type;

const MIGRATION_NAME = 'mailCorpusBodySplit';
/** Messages in one transaction. An old document holds up to ~230 kB of body. */
const MIGRATION_PAGE = 25;
const MIGRATION_PAGE_MAX = 50;
/** Stop a page early near this many bytes, far under the 16 MB read limit. */
const MIGRATION_MAX_BYTES = 6_000_000;

async function orderedAccounts(ctx: any, userId: string | undefined, includeDisconnected: boolean) {
  const rows: Doc<'connectedAccounts'>[] = userId
    ? await ctx.db
        .query('connectedAccounts')
        .withIndex('by_user', (q: any) => q.eq('userId', userId))
        .collect()
    : await ctx.db.query('connectedAccounts').collect();
  // Live mailboxes first: their readers gain first. The mail of an account
  // that is not connected moves only on request, because the dead-source
  // purge can delete it.
  const live = rows.filter((row) => row.status === 'connected');
  const other = includeDisconnected ? rows.filter((row) => row.status !== 'connected') : [];
  const order = (a: Doc<'connectedAccounts'>, b: Doc<'connectedAccounts'>) =>
    a._creationTime - b._creationTime || String(a._id).localeCompare(String(b._id));
  return [...live.sort(order), ...other.sort(order)];
}

/**
 * One-time move of inline bodies from mailCorpusMessages to mailCorpusBodies.
 *
 * Each call reads one page of one mailbox (25 messages by default, at most
 * 50, and at most ~6 MB), writes the body documents, clears the inline
 * fields, and schedules the next page, then the next mailbox. Live mailboxes
 * go first. It is idempotent: a split document is counted and skipped, so a
 * second run writes nothing. Readers work during the run: they read the body
 * table first and use the inline fields of a document that is not split yet.
 *
 * Run a dry run first (reads and counts, no writes), then the real pass:
 *   CONVEX_DEPLOYMENT=prod:proficient-viper-594 npx convex run mailBodies:migrateMessageBodies '{"dryRun": true}'
 *   CONVEX_DEPLOYMENT=prod:proficient-viper-594 npx convex run mailBodies:migrateMessageBodies '{}'
 * Add `"userId": "<clerk user id>"` for one user. Add
 * `"includeDisconnected": true` to also move the mail of accounts that are not
 * connected. The totals are in the deployment logs and, after a full real
 * run, in the dataMigrations row `mailCorpusBodySplit`.
 */
export const migrateMessageBodies = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    userId: v.optional(v.string()),
    includeDisconnected: v.optional(v.boolean()),
    limit: v.optional(v.number()),
    // Continuation state. The scheduler sets these; a caller leaves them out.
    // `account` is the mailbox that `cursor` belongs to.
    accountIndex: v.optional(v.number()),
    account: v.optional(v.object({ userId: v.string(), accountId: v.string() })),
    cursor: v.optional(v.string()),
    totals: v.optional(migrationTotals),
  },
  handler: async (ctx, args) => {
    const dryRun = Boolean(args.dryRun);
    const includeDisconnected = Boolean(args.includeDisconnected);
    const totals: MigrationTotals = args.totals ?? {
      accounts: 0,
      scanned: 0,
      split: 0,
      bodies: 0,
      alreadySplit: 0,
      movedChars: 0,
    };
    const accounts = await orderedAccounts(ctx, args.userId, includeDisconnected);
    // The list can change between pages. Find the mailbox of the cursor
    // again; if it is gone, go on at the same position with a new cursor.
    let accountIndex = args.accountIndex ?? 0;
    let cursor = args.cursor;
    if (args.account) {
      const found = accounts.findIndex(
        (row) => row.userId === args.account?.userId && row.accountId === args.account?.accountId,
      );
      if (found >= 0) accountIndex = found;
      else cursor = undefined;
    }
    const scope = `${args.userId ? `user ${args.userId}` : 'all users'}${includeDisconnected ? ', with disconnected accounts' : ''}`;
    const account = accounts[accountIndex];
    if (!account) {
      console.log(
        `[mail body split] ${scope}: ${totals.accounts} mailboxes, ${totals.scanned} messages scanned, ${totals.split} split, ${totals.bodies} body documents, ${totals.alreadySplit} already split, ${totals.movedChars} characters moved${dryRun ? ' (dry run)' : ''}`,
      );
      if (!dryRun && !args.userId) await recordMigration(ctx, totals, includeDisconnected);
      return { done: true, totals };
    }
    if (!cursor) totals.accounts += 1;
    const page = await ctx.db
      .query('mailCorpusMessages')
      .withIndex('by_user_account', (q) => q.eq('userId', account.userId).eq('accountId', account.accountId))
      .paginate({
        cursor: cursor ?? null,
        numItems: Math.min(Math.max(Math.floor(args.limit ?? MIGRATION_PAGE), 1), MIGRATION_PAGE_MAX),
        maximumBytesRead: MIGRATION_MAX_BYTES,
      });
    const ts = now();
    for (const doc of page.page) {
      totals.scanned += 1;
      if (!isLegacyCorpusMessage(doc)) {
        totals.alreadySplit += 1;
        continue;
      }
      const plan = planBodyWrite(doc, {});
      totals.split += 1;
      if (plan.textBody !== undefined || plan.htmlBody !== undefined) totals.bodies += 1;
      totals.movedChars += (plan.textBody?.length ?? 0) + (plan.htmlBody?.length ?? 0);
      if (dryRun) continue;
      if (plan.textBody !== undefined || plan.htmlBody !== undefined)
        await writeMessageBody(ctx, doc, plan, ts);
      // updatedAt stays: the content of the message did not change.
      await ctx.db.patch(doc._id, splitPatch(doc, plan));
    }
    const next = page.isDone
      ? { accountIndex: accountIndex + 1, account: undefined, cursor: undefined }
      : {
          accountIndex,
          account: { userId: account.userId, accountId: account.accountId },
          cursor: page.continueCursor,
        };
    await ctx.scheduler.runAfter(0, internal.mailBodies.migrateMessageBodies, {
      dryRun: args.dryRun,
      userId: args.userId,
      includeDisconnected: args.includeDisconnected,
      limit: args.limit,
      ...next,
      totals,
    });
    return { done: false, totals };
  },
});

async function recordMigration(ctx: any, totals: MigrationTotals, includeDisconnected: boolean) {
  const row = await ctx.db
    .query('dataMigrations')
    .withIndex('by_name', (q: any) => q.eq('name', MIGRATION_NAME))
    .unique();
  const fields = {
    status: 'completed' as const,
    completedAt: now(),
    updatedAt: now(),
    result: { totals, includeDisconnected },
  };
  if (row) await ctx.db.patch(row._id, fields);
  else await ctx.db.insert('dataMigrations', { name: MIGRATION_NAME, ...fields });
}
