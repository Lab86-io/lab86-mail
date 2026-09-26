import { v } from 'convex/values';
import { assertWorkOpen } from '../lib/albatross/work-lifecycle';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { internalMutation, mutation, query } from './_generated/server';
import { recordCompletionEvent } from './albatrossWork';
import { now, requireInternalSecret } from './lib';

// Kanban boards with sharing (spec M2). Every function resolves its caller
// through resolveUserId: browser calls authenticate via Clerk identity, the
// Next server (AI tools, suggestion acceptance) passes the internal secret
// plus an explicit userId. Public read-only access goes through
// getPublicBoard with a token and touches nothing else.

async function resolveUserId(
  ctx: QueryCtx | MutationCtx,
  args: { internalSecret?: string; userId?: string },
): Promise<string> {
  if (args.internalSecret) {
    requireInternalSecret(args.internalSecret);
    if (!args.userId) throw new Error('userId required with internal secret.');
    return args.userId;
  }
  const identity = await ctx.auth.getUserIdentity();
  if (!identity?.subject) throw new Error('Not authenticated');
  return identity.subject;
}

type Role = 'owner' | 'member' | 'viewer';

const ROLE_RANK: Record<Role, number> = { owner: 3, member: 2, viewer: 1 };

async function boardRole(
  ctx: QueryCtx | MutationCtx,
  boardId: Id<'boards'>,
  userId: string,
  userEmail?: string,
): Promise<{ board: any; role: Role | null }> {
  const board = await ctx.db.get(boardId);
  if (!board) return { board: null, role: null };
  if (board.ownerUserId === userId) return { board, role: 'owner' };
  const memberships = await ctx.db
    .query('boardMembers')
    .withIndex('by_board', (q) => q.eq('boardId', boardId))
    .collect();
  const mine = memberships.find(
    (member) =>
      member.userId === userId || (userEmail && member.email.toLowerCase() === userEmail.toLowerCase()),
  );
  return { board, role: mine ? mine.role : null };
}

async function requireBoard(
  ctx: QueryCtx | MutationCtx,
  boardId: Id<'boards'>,
  userId: string,
  minRole: Role,
) {
  const { board, role } = await boardRole(ctx, boardId, userId);
  if (!board || !role || ROLE_RANK[role] < ROLE_RANK[minRole]) {
    throw new Error('Board not found or access denied.');
  }
  return { board, role };
}

// Fractional ordering: appends step by a whole unit; insertions take the
// midpoint. When midpoints exhaust float precision the column renumbers.
const ORDER_STEP = 1024;

function nextOrder(existing: number[]): number {
  return existing.length ? Math.max(...existing) + ORDER_STEP : ORDER_STEP;
}

// "Done" column ⟺ completed. Moving a card into the Done column completes it and
// moving it out reopens it; completing/reopening a card moves it in/out of Done.
// Unifying both directions in these mutations keeps drag-and-drop, the
// checkmark, and the AI tools consistent with one rule.
function isDoneColumn(name?: string | null): boolean {
  return (
    String(name || '')
      .trim()
      .toLowerCase() === 'done'
  );
}

async function columnsForBoard(ctx: MutationCtx, boardId: Id<'boards'>) {
  const columns = await ctx.db
    .query('boardColumns')
    .withIndex('by_board', (q) => q.eq('boardId', boardId))
    .collect();
  return columns.sort((a, b) => a.order - b.order);
}

async function appendOrderInColumn(ctx: MutationCtx, columnId: Id<'boardColumns'>): Promise<number> {
  const siblings = await ctx.db
    .query('cards')
    .withIndex('by_column_order', (q) => q.eq('columnId', columnId))
    .collect();
  return nextOrder(siblings.map((sibling) => sibling.order));
}

// Assignees must be board members (owner included); normalize casing and
// reject anything off-board so a direct client call can't write arbitrary
// strings into the assignee contract.
async function normalizeAssignees(
  ctx: QueryCtx | MutationCtx,
  boardId: Id<'boards'>,
  assignees: string[] | undefined,
): Promise<string[] | undefined> {
  if (assignees === undefined) return undefined;
  if (!assignees.length) return [];
  const board = await ctx.db.get(boardId);
  const members = await ctx.db
    .query('boardMembers')
    .withIndex('by_board', (q) => q.eq('boardId', boardId))
    .collect();
  const ownerEmail = board ? await actorEmail(ctx, board.ownerUserId) : undefined;
  const allowed = new Set(
    [...members.map((m) => m.email), ...(ownerEmail ? [ownerEmail] : [])].map((e) => e.toLowerCase()),
  );
  const normalized = [...new Set(assignees.map((e) => e.trim().toLowerCase()))].filter(Boolean);
  const invalid = normalized.find((e) => !allowed.has(e));
  if (invalid) throw new Error(`Assignee "${invalid}" is not a member of this board.`);
  return normalized;
}

const callerArgs = {
  internalSecret: v.optional(v.string()),
  userId: v.optional(v.string()),
};

const STARTER_COLUMNS = ['Today', 'This Week', 'Backlog', 'Done'];

const ACTIVITY_CAP = 100;

async function actorEmail(ctx: QueryCtx | MutationCtx, userId: string): Promise<string | undefined> {
  const me = await ctx.db
    .query('users')
    .withIndex('by_clerk_user_id', (q) => q.eq('clerkUserId', userId))
    .first();
  return me?.email;
}

async function appendActivity(ctx: MutationCtx, card: any, userId: string, action: string, detail?: string) {
  const entry = {
    id: `a_${now()}_${Math.floor(Math.random() * 1e6)}`,
    actorUserId: userId,
    actorEmail: await actorEmail(ctx, userId),
    action,
    detail: detail?.slice(0, 300),
    createdAt: now(),
  };
  const activity = [...(card.activity || []), entry].slice(-ACTIVITY_CAP);
  await ctx.db.patch(card._id, { activity });
}

// Completion history (issue #87/#18): the first flip of a card from open to
// completed records a completionEvent, whether it happened via the completed
// toggle (updateCard) or a drag into the Done column (moveCard). Reopening
// does not erase history; recordCompletionEvent is best-effort and never
// fails the card mutation.
async function recordCardCompletion(ctx: MutationCtx, userId: string, card: any, completedAt: number) {
  await recordCompletionEvent(ctx, {
    userId,
    artifactKind: 'task',
    artifactId: String(card._id),
    completedAt,
    dueAt: typeof card.dueAt === 'number' ? card.dueAt : undefined,
  });
}

/**
 * Complete a plan-bound card inside the Work step mutation. Keeping this in
 * the same transaction as the Work progress write removes the provider/tool
 * round trip while preserving the board's Done-column and activity rules.
 */
export async function completeCardForWork(
  ctx: MutationCtx,
  userId: string,
  cardId: Id<'cards'>,
  completedAt: number,
) {
  const card = await ctx.db.get(cardId);
  if (!card || card.userId !== userId) throw new Error('Card not found.');
  if (card.completedAt) return { transitioned: false, card };

  const patch: Record<string, unknown> = { completedAt, updatedAt: completedAt };
  const columns = await columnsForBoard(ctx, card.boardId);
  const done = columns.find((column) => isDoneColumn(column.name));
  if (done && card.columnId !== done._id) {
    patch.columnId = done._id;
    patch.order = await appendOrderInColumn(ctx, done._id);
  }
  await recordCardCompletion(ctx, userId, card, completedAt);
  await ctx.db.patch(cardId, patch);
  const fresh = await ctx.db.get(cardId);
  if (fresh) await appendActivity(ctx, fresh, userId, 'updated', 'completedAt');
  return { transitioned: true, card: (await ctx.db.get(cardId)) || card };
}

function sourceIndexFields(source: any) {
  const threadId = typeof source?.threadId === 'string' ? source.threadId : undefined;
  const eventId =
    typeof source?.eventId === 'string'
      ? source.eventId
      : typeof source?.providerEventId === 'string'
        ? source.providerEventId
        : undefined;
  const accountId = typeof source?.accountId === 'string' ? source.accountId : undefined;
  return {
    sourceThreadId: threadId,
    sourceCalendarEventId: eventId,
    sourceAccountId: accountId,
  };
}

// Shared board factory: one insert path for the default Personal board, user-
// created boards, and per-area boards (convex/albatross.ts createArea), so
// every board is born with real columns and the Done-column completion rule
// applies everywhere.
export async function insertBoardWithColumns(
  ctx: MutationCtx,
  ownerUserId: string,
  title: string,
  options: { columns?: string[]; isDefault?: boolean } = {},
): Promise<Id<'boards'>> {
  const ts = now();
  const boardId = await ctx.db.insert('boards', {
    ownerUserId,
    title: title.trim() || 'Untitled board',
    ...(options.isDefault ? { isDefault: true } : {}),
    createdAt: ts,
    updatedAt: ts,
  });
  const columns = options.columns?.length ? options.columns : STARTER_COLUMNS;
  for (let i = 0; i < columns.length; i += 1) {
    await ctx.db.insert('boardColumns', {
      boardId,
      name: columns[i],
      order: (i + 1) * ORDER_STEP,
      createdAt: ts,
      updatedAt: ts,
    });
  }
  return boardId;
}

export const ensureDefaultBoard = mutation({
  args: { ...callerArgs },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const owned = await ctx.db
      .query('boards')
      .withIndex('by_owner', (q) => q.eq('ownerUserId', userId))
      .collect();
    // Only an owned board marked default is the default. An Area board or a
    // user-made board is not, so a user without one gets a new Personal board.
    const ownedDefault = owned.find((board) => board.isDefault === true);
    if (ownedDefault) return ownedDefault._id;
    return insertBoardWithColumns(ctx, userId, 'Personal', { isDefault: true });
  },
});

export const createBoard = mutation({
  args: { ...callerArgs, title: v.string(), columns: v.optional(v.array(v.string())) },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    return insertBoardWithColumns(ctx, userId, args.title, { columns: args.columns });
  },
});

export const renameBoard = mutation({
  args: { ...callerArgs, boardId: v.id('boards'), title: v.string() },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    await requireBoard(ctx, args.boardId, userId, 'owner');
    await ctx.db.patch(args.boardId, { title: args.title.trim(), updatedAt: now() });
  },
});

export const deleteBoard = mutation({
  args: { ...callerArgs, boardId: v.id('boards') },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    await requireBoard(ctx, args.boardId, userId, 'owner');
    const [columns, cards, members] = await Promise.all([
      ctx.db
        .query('boardColumns')
        .withIndex('by_board', (q) => q.eq('boardId', args.boardId))
        .collect(),
      ctx.db
        .query('cards')
        .withIndex('by_board', (q) => q.eq('boardId', args.boardId))
        .collect(),
      ctx.db
        .query('boardMembers')
        .withIndex('by_board', (q) => q.eq('boardId', args.boardId))
        .collect(),
    ]);
    for (const row of [...cards, ...columns, ...members]) await ctx.db.delete(row._id);
    await ctx.db.delete(args.boardId);
    await deleteStoredBlobs(
      ctx,
      cards.flatMap((card) => storageIdsOf(card.attachments)),
    );
  },
});

// --- sharing ----------------------------------------------------------------

export const setPublicLink = mutation({
  args: { ...callerArgs, boardId: v.id('boards'), enabled: v.boolean(), token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    await requireBoard(ctx, args.boardId, userId, 'owner');
    if (args.enabled && !args.token) throw new Error('token required to enable the public link.');
    await ctx.db.patch(args.boardId, {
      publicToken: args.enabled ? args.token : undefined,
      updatedAt: now(),
    });
    return { publicToken: args.enabled ? args.token : null };
  },
});

export const inviteMember = mutation({
  args: {
    ...callerArgs,
    boardId: v.id('boards'),
    email: v.string(),
    role: v.union(v.literal('member'), v.literal('viewer')),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const { board } = await requireBoard(ctx, args.boardId, userId, 'owner');
    const email = args.email.trim().toLowerCase();
    if (!email.includes('@')) throw new Error('Invalid email.');
    const existing = await ctx.db
      .query('boardMembers')
      .withIndex('by_board', (q) => q.eq('boardId', args.boardId))
      .collect();
    const duplicate = existing.find((member) => member.email.toLowerCase() === email);
    if (duplicate) {
      await ctx.db.patch(duplicate._id, { role: args.role, updatedAt: now() });
      return duplicate._id;
    }
    // Link immediately when the invitee already has an account.
    const invitee = await ctx.db
      .query('users')
      .withIndex('by_email', (q) => q.eq('email', email))
      .first();
    const ts = now();
    return ctx.db.insert('boardMembers', {
      boardId: board._id,
      userId: invitee?.clerkUserId,
      email,
      role: args.role,
      invitedBy: userId,
      status: invitee ? 'active' : 'invited',
      createdAt: ts,
      updatedAt: ts,
    });
  },
});

export const removeMember = mutation({
  args: { ...callerArgs, boardId: v.id('boards'), memberId: v.id('boardMembers') },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const member = await ctx.db.get(args.memberId);
    if (!member || member.boardId !== args.boardId) throw new Error('Member not found.');
    // Owners remove anyone; members may remove themselves (leave).
    const { role } = await boardRole(ctx, args.boardId, userId);
    if (role !== 'owner' && member.userId !== userId) throw new Error('Access denied.');
    await ctx.db.delete(args.memberId);
  },
});

// --- columns ----------------------------------------------------------------

export const createColumn = mutation({
  args: { ...callerArgs, boardId: v.id('boards'), name: v.string() },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    await requireBoard(ctx, args.boardId, userId, 'member');
    const columns = await ctx.db
      .query('boardColumns')
      .withIndex('by_board', (q) => q.eq('boardId', args.boardId))
      .collect();
    const ts = now();
    return ctx.db.insert('boardColumns', {
      boardId: args.boardId,
      name: args.name.trim() || 'Untitled',
      order: nextOrder(columns.map((column) => column.order)),
      createdAt: ts,
      updatedAt: ts,
    });
  },
});

export const updateColumn = mutation({
  args: {
    ...callerArgs,
    columnId: v.id('boardColumns'),
    name: v.optional(v.string()),
    order: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const column = await ctx.db.get(args.columnId);
    if (!column) throw new Error('Column not found.');
    await requireBoard(ctx, column.boardId, userId, 'member');
    const patch: Record<string, unknown> = { updatedAt: now() };
    if (args.name !== undefined) patch.name = args.name.trim() || column.name;
    if (args.order !== undefined) patch.order = args.order;
    await ctx.db.patch(args.columnId, patch);
  },
});

export const deleteColumn = mutation({
  args: { ...callerArgs, columnId: v.id('boardColumns') },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const column = await ctx.db.get(args.columnId);
    if (!column) throw new Error('Column not found.');
    await requireBoard(ctx, column.boardId, userId, 'member');
    const cards = await ctx.db
      .query('cards')
      .withIndex('by_column_order', (q) => q.eq('columnId', args.columnId))
      .collect();
    for (const card of cards) await ctx.db.delete(card._id);
    await ctx.db.delete(args.columnId);
    await deleteUnreferencedBlobs(
      ctx,
      column.boardId,
      cards.flatMap((card) => storageIdsOf(card.attachments)),
    );
  },
});

// --- cards ------------------------------------------------------------------

const cardFields = {
  title: v.optional(v.string()),
  description: v.optional(v.string()),
  labels: v.optional(v.array(v.string())),
  priority: v.optional(v.union(v.literal('low'), v.literal('medium'), v.literal('high'))),
  weight: v.optional(v.union(v.number(), v.null())),
  assignees: v.optional(v.array(v.string())),
  dueAt: v.optional(v.union(v.number(), v.null())),
  completedAt: v.optional(v.union(v.number(), v.null())),
  attachments: v.optional(
    v.array(
      v.object({
        name: v.string(),
        url: v.optional(v.string()),
        storageId: v.optional(v.id('_storage')),
        contentType: v.optional(v.string()),
        size: v.optional(v.number()),
      }),
    ),
  ),
  source: v.optional(v.any()),
};

export const createCard = mutation({
  args: {
    ...callerArgs,
    boardId: v.id('boards'),
    columnId: v.id('boardColumns'),
    title: v.string(),
    description: v.optional(v.string()),
    labels: v.optional(v.array(v.string())),
    priority: v.optional(v.union(v.literal('low'), v.literal('medium'), v.literal('high'))),
    weight: v.optional(v.number()),
    assignees: v.optional(v.array(v.string())),
    dueAt: v.optional(v.number()),
    attachments: v.optional(
      v.array(
        v.object({
          name: v.string(),
          url: v.optional(v.string()),
          storageId: v.optional(v.id('_storage')),
          contentType: v.optional(v.string()),
          size: v.optional(v.number()),
        }),
      ),
    ),
    source: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    await requireBoard(ctx, args.boardId, userId, 'member');
    const column = await ctx.db.get(args.columnId);
    if (!column || column.boardId !== args.boardId) throw new Error('Column not found on board.');
    const sourceWorkId =
      typeof args.source?.intentId === 'string'
        ? ctx.db.normalizeId('albatrossIntents', args.source.intentId)
        : null;
    if (typeof args.source?.intentId === 'string' && !sourceWorkId) throw new Error('Work not found.');
    if (sourceWorkId) {
      const work = await ctx.db.get(sourceWorkId);
      if (!work || work.userId !== userId) throw new Error('Work not found.');
      assertWorkOpen(work);
    }
    const assignees = await normalizeAssignees(ctx, args.boardId, args.assignees);
    const siblings = await ctx.db
      .query('cards')
      .withIndex('by_column_order', (q) => q.eq('columnId', args.columnId))
      .collect();
    const ts = now();
    const createdId = await ctx.db.insert('cards', {
      boardId: args.boardId,
      columnId: args.columnId,
      userId,
      title: args.title.trim() || 'Untitled card',
      description: args.description,
      labels: args.labels,
      priority: args.priority,
      weight: args.weight,
      assignees,
      dueAt: args.dueAt,
      attachments: await verifiedAttachments(ctx, args.attachments),
      order: nextOrder(siblings.map((card) => card.order)),
      source: args.source,
      ...sourceIndexFields(args.source),
      createdAt: ts,
      updatedAt: ts,
    });
    const created = await ctx.db.get(createdId);
    if (created) await appendActivity(ctx, created, userId, 'created');
    return createdId;
  },
});

export const updateCard = mutation({
  args: { ...callerArgs, cardId: v.id('cards'), ...cardFields },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const card = await ctx.db.get(args.cardId);
    if (!card) throw new Error('Card not found.');
    await requireBoard(ctx, card.boardId, userId, 'member');
    const patch: Record<string, unknown> = { updatedAt: now() };
    if (args.title !== undefined) patch.title = args.title.trim() || card.title;
    if (args.description !== undefined) patch.description = args.description;
    if (args.labels !== undefined) patch.labels = args.labels;
    if (args.priority !== undefined) patch.priority = args.priority;
    if (args.weight !== undefined) patch.weight = args.weight === null ? undefined : args.weight;
    if (args.assignees !== undefined)
      patch.assignees = await normalizeAssignees(ctx, card.boardId, args.assignees);
    if (args.attachments !== undefined) {
      patch.attachments = await verifiedAttachments(ctx, args.attachments);
      const kept = new Set(storageIdsOf(args.attachments).map(String));
      const removed = storageIdsOf(card.attachments).filter((id) => !kept.has(String(id)));
      // Undo of this edit puts the old list back, so a removed file is kept
      // for a grace period and deleted only if the card still omits it.
      if (removed.length) {
        await ctx.scheduler.runAfter(DETACHED_BLOB_GRACE_MS, internal.boards.deleteDetachedAttachments, {
          cardId: args.cardId,
          storageIds: removed,
        });
      }
    }
    if (args.source !== undefined) {
      patch.source = args.source;
      Object.assign(patch, sourceIndexFields(args.source));
    }
    // null clears; undefined leaves untouched.
    if (args.dueAt !== undefined) patch.dueAt = args.dueAt === null ? undefined : args.dueAt;
    if (args.completedAt !== undefined) {
      const completing = args.completedAt !== null;
      // The completion toggle is ALWAYS honored — we never block marking a card
      // done on a board's shape (a board may legitimately have no "Done"
      // column). The column move below is best-effort: it only fires when a
      // matching destination column actually exists, so completion state and
      // column membership stay consistent on boards that have a Done column,
      // and the toggle still works on those that don't.
      patch.completedAt = completing ? args.completedAt : undefined;
      if (completing && !card.completedAt) {
        await recordCardCompletion(ctx, userId, card, args.completedAt as number);
      }
      const columns = await columnsForBoard(ctx, card.boardId);
      if (completing) {
        const done = columns.find((column) => isDoneColumn(column.name));
        if (done && card.columnId !== done._id) {
          patch.columnId = done._id;
          patch.order = await appendOrderInColumn(ctx, done._id);
        }
      } else {
        const current = columns.find((column) => column._id === card.columnId);
        if (current && isDoneColumn(current.name)) {
          const target = columns.find((column) => !isDoneColumn(column.name));
          if (target) {
            patch.columnId = target._id;
            patch.order = await appendOrderInColumn(ctx, target._id);
          }
        }
      }
    }
    await ctx.db.patch(args.cardId, patch);
    const changed = Object.keys(patch).filter((key) => key !== 'updatedAt');
    let fresh = await ctx.db.get(args.cardId);
    if (changed.length) {
      if (fresh) await appendActivity(ctx, fresh, userId, 'updated', changed.join(', '));
      fresh = await ctx.db.get(args.cardId);
    }
    return { previous: snapshotCard(card), card: await cardStatePayload(ctx, fresh || card) };
  },
});

export const moveCard = mutation({
  args: {
    ...callerArgs,
    cardId: v.id('cards'),
    columnId: v.id('boardColumns'),
    // Neighbours after the drop; omitted = append to column end.
    beforeOrder: v.optional(v.number()),
    afterOrder: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const card = await ctx.db.get(args.cardId);
    if (!card) throw new Error('Card not found.');
    await requireBoard(ctx, card.boardId, userId, 'member');
    const column = await ctx.db.get(args.columnId);
    if (!column || column.boardId !== card.boardId) throw new Error('Column not found on board.');

    let order: number;
    if (args.beforeOrder !== undefined && args.afterOrder !== undefined) {
      order = (args.beforeOrder + args.afterOrder) / 2;
      // Midpoints exhausted — renumber the destination column, then place
      // the card between its intended neighbours' NEW orders (appending it
      // to the end here was a drop-position bug).
      if (!(args.beforeOrder < order && order < args.afterOrder)) {
        const siblings = await ctx.db
          .query('cards')
          .withIndex('by_column_order', (q) => q.eq('columnId', args.columnId))
          .collect();
        siblings.sort((a, b) => a.order - b.order);
        const beforeIdx = siblings.findIndex((s) => s.order === args.beforeOrder);
        let cursor = ORDER_STEP;
        const reassigned: number[] = [];
        for (const sibling of siblings) {
          await ctx.db.patch(sibling._id, { order: cursor });
          reassigned.push(cursor);
          cursor += ORDER_STEP;
        }
        const newBefore = beforeIdx >= 0 ? reassigned[beforeIdx] : reassigned[reassigned.length - 1];
        order = newBefore + ORDER_STEP / 2;
      }
    } else if (args.beforeOrder !== undefined) {
      order = args.beforeOrder + ORDER_STEP;
    } else if (args.afterOrder !== undefined) {
      order = args.afterOrder / 2;
    } else {
      const siblings = await ctx.db
        .query('cards')
        .withIndex('by_column_order', (q) => q.eq('columnId', args.columnId))
        .collect();
      order = nextOrder(siblings.map((sibling) => sibling.order));
    }
    // Full snapshot (not just columnId/order) so callers can restore completion
    // state too, now that a move into/out of Done flips completedAt.
    const previous = snapshotCard(card);
    const movePatch: Record<string, unknown> = { columnId: args.columnId, order, updatedAt: now() };
    // Keep completion in sync with the Done column.
    if (isDoneColumn(column.name)) {
      if (!card.completedAt) {
        const completedAt = now();
        movePatch.completedAt = completedAt;
        await recordCardCompletion(ctx, userId, card, completedAt);
      }
    } else if (card.completedAt) {
      movePatch.completedAt = undefined; // leaving Done reopens the card
    }
    await ctx.db.patch(args.cardId, movePatch);
    if (previous.columnId !== args.columnId) {
      const fresh = await ctx.db.get(args.cardId);
      if (fresh) await appendActivity(ctx, fresh, userId, 'moved', `to ${column.name}`);
    }
    const fresh = await ctx.db.get(args.cardId);
    return { previous, card: await cardStatePayload(ctx, fresh || card) };
  },
});

export const getCardState = query({
  args: { ...callerArgs, cardId: v.id('cards') },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const card = await ctx.db.get(args.cardId);
    if (!card) throw new Error('Card not found.');
    await requireBoard(ctx, card.boardId, userId, 'viewer');
    return cardStatePayload(ctx, card);
  },
});

export const deleteCard = mutation({
  args: { ...callerArgs, cardId: v.id('cards') },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const card = await ctx.db.get(args.cardId);
    if (!card) throw new Error('Card not found.');
    await requireBoard(ctx, card.boardId, userId, 'member');
    await ctx.db.delete(args.cardId);
    // Undo recreates the card without its files, so they can go now.
    await deleteUnreferencedBlobs(ctx, card.boardId, storageIdsOf(card.attachments));
    return { previous: snapshotCard(card) };
  },
});

export const addComment = mutation({
  args: { ...callerArgs, cardId: v.id('cards'), body: v.string() },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const card = await ctx.db.get(args.cardId);
    if (!card) throw new Error('Card not found.');
    // Everyone with board access can join the conversation, viewers included.
    await requireBoard(ctx, card.boardId, userId, 'viewer');
    const body = args.body.trim();
    if (!body) throw new Error('Comment is empty.');
    const comment = {
      id: `c_${now()}_${Math.floor(Math.random() * 1e6)}`,
      authorUserId: userId,
      authorEmail: await actorEmail(ctx, userId),
      body: body.slice(0, 4000),
      createdAt: now(),
    };
    await ctx.db.patch(args.cardId, {
      comments: [...(card.comments || []), comment],
      updatedAt: now(),
    });
    await appendActivity(ctx, { ...card, _id: args.cardId }, userId, 'commented');
    return comment;
  },
});

export const attachToCard = mutation({
  args: {
    ...callerArgs,
    cardId: v.id('cards'),
    name: v.string(),
    url: v.optional(v.string()),
    storageId: v.optional(v.id('_storage')),
    contentType: v.optional(v.string()),
    size: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const card = await ctx.db.get(args.cardId);
    if (!card) throw new Error('Card not found.');
    await requireBoard(ctx, card.boardId, userId, 'member');
    if (!args.url && !args.storageId) throw new Error('url or storageId required.');
    const [attachment] = (await verifiedAttachments(ctx, [
      {
        name: args.name.trim() || args.url || 'attachment',
        url: args.url,
        storageId: args.storageId,
        contentType: args.contentType,
        size: args.size,
      },
    ])) as AttachmentInput[];
    await ctx.db.patch(args.cardId, {
      attachments: [...(card.attachments || []), attachment],
      updatedAt: now(),
    });
    await appendActivity(ctx, { ...card, _id: args.cardId }, userId, 'attached', args.name);
    return { ok: true, previous: snapshotCard(card) };
  },
});

// File uploads go straight from the browser to Convex storage; the returned
// storage id lands in the card's attachments.
export const generateAttachmentUploadUrl = mutation({
  args: {
    ...callerArgs,
    cardId: v.optional(v.id('cards')),
    // Pre-create uploads (the new-card dialog) authorize against the board.
    boardId: v.optional(v.id('boards')),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    let boardId = args.boardId;
    if (!boardId && args.cardId) {
      const card = await ctx.db.get(args.cardId);
      if (!card) throw new Error('Card not found.');
      boardId = card.boardId;
    }
    if (!boardId) throw new Error('cardId or boardId required.');
    await requireBoard(ctx, boardId, userId, 'member');
    return await ctx.storage.generateUploadUrl();
  },
});

// --- attachment storage (TSK-2) ---------------------------------------------

export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
// Active content that a browser would run or render as a page.
const BLOCKED_ATTACHMENT_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'text/javascript',
  'application/javascript',
  'application/x-msdownload',
  'application/x-sh',
]);
const DETACHED_BLOB_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

type AttachmentInput = {
  name: string;
  url?: string;
  storageId?: Id<'_storage'>;
  contentType?: string;
  size?: number;
};

function storageIdsOf(attachments: AttachmentInput[] | undefined): Id<'_storage'>[] {
  return (attachments || []).map((attachment) => attachment.storageId).filter(Boolean) as Id<'_storage'>[];
}

// The upload URL cannot carry a limit, so a stored file is checked on the
// server. Size and type come from storage metadata when it has them, never
// from the client's claim alone.
async function checkStoredFile(
  ctx: MutationCtx,
  storageId: Id<'_storage'>,
  claimedType: string | undefined,
): Promise<{ ok: true; size: number; contentType?: string } | { ok: false; error: string }> {
  const meta = await ctx.db.system.get(storageId);
  if (!meta) return { ok: false, error: 'The uploaded file was not found. Upload it again.' };
  const contentType = String(meta.contentType || claimedType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (meta.size > ATTACHMENT_MAX_BYTES) return { ok: false, error: 'Attachments can be at most 25 MB.' };
  if (BLOCKED_ATTACHMENT_TYPES.has(contentType)) {
    return { ok: false, error: 'This file type cannot be attached. Upload a PDF, image, or document.' };
  }
  return { ok: true, size: meta.size, contentType: contentType || undefined };
}

// Card writes refuse a file that fails the check. (A throw rolls the whole
// mutation back, so the delete happens in verifyAttachmentUpload.)
async function verifiedAttachments(
  ctx: MutationCtx,
  attachments: AttachmentInput[] | undefined,
): Promise<AttachmentInput[] | undefined> {
  if (!attachments) return attachments;
  return Promise.all(
    attachments.map(async (attachment) => {
      if (!attachment.storageId) return attachment;
      const checked = await checkStoredFile(ctx, attachment.storageId, attachment.contentType);
      if (!checked.ok) throw new Error(checked.error);
      return { ...attachment, size: checked.size, contentType: checked.contentType };
    }),
  );
}

// Clients call this right after an upload. A file that fails the check is
// deleted at once and the error is returned, not thrown, so the delete stays.
export const verifyAttachmentUpload = mutation({
  args: {
    ...callerArgs,
    storageId: v.id('_storage'),
    cardId: v.optional(v.id('cards')),
    boardId: v.optional(v.id('boards')),
    contentType: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    let boardId = args.boardId;
    if (!boardId && args.cardId) boardId = (await ctx.db.get(args.cardId))?.boardId;
    if (!boardId) throw new Error('cardId or boardId required.');
    await requireBoard(ctx, boardId, userId, 'member');
    const checked = await checkStoredFile(ctx, args.storageId, args.contentType);
    if (!checked.ok) await deleteStoredBlobs(ctx, [args.storageId]);
    return checked;
  },
});

async function deleteStoredBlobs(ctx: MutationCtx, ids: Id<'_storage'>[]) {
  for (const id of new Set(ids)) {
    const meta = await ctx.db.system.get(id);
    if (meta) await ctx.storage.delete(id);
  }
}

// Deletes files that no other card on the board still refers to.
async function deleteUnreferencedBlobs(ctx: MutationCtx, boardId: Id<'boards'>, ids: Id<'_storage'>[]) {
  if (!ids.length) return;
  const remaining = await ctx.db
    .query('cards')
    .withIndex('by_board', (q) => q.eq('boardId', boardId))
    .collect();
  const referenced = new Set(remaining.flatMap((card) => storageIdsOf(card.attachments)).map(String));
  await deleteStoredBlobs(
    ctx,
    ids.filter((id) => !referenced.has(String(id))),
  );
}

export const deleteDetachedAttachments = internalMutation({
  args: { cardId: v.id('cards'), storageIds: v.array(v.id('_storage')) },
  handler: async (ctx, args) => {
    const card = await ctx.db.get(args.cardId);
    const stillAttached = new Set(storageIdsOf(card?.attachments).map(String));
    const detached = args.storageIds.filter((id) => !stillAttached.has(String(id)));
    if (card) await deleteUnreferencedBlobs(ctx, card.boardId, detached);
    else await deleteStoredBlobs(ctx, detached);
  },
});

// --- reads ------------------------------------------------------------------

export const listMyBoards = query({
  args: { ...callerArgs },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const me = await ctx.db
      .query('users')
      .withIndex('by_clerk_user_id', (q) => q.eq('clerkUserId', userId))
      .first();
    const [owned, byUser, byEmail] = await Promise.all([
      ctx.db
        .query('boards')
        .withIndex('by_owner', (q) => q.eq('ownerUserId', userId))
        .collect(),
      ctx.db
        .query('boardMembers')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .collect(),
      me?.email
        ? ctx.db
            .query('boardMembers')
            .withIndex('by_email', (q) => q.eq('email', me.email.toLowerCase()))
            .collect()
        : Promise.resolve([]),
    ]);
    const memberships = [...byUser, ...byEmail.filter((m) => m.userId !== userId)];
    const memberBoards = (await Promise.all(memberships.map((member) => ctx.db.get(member.boardId)))).filter(
      Boolean,
    ) as any[];
    const seen = new Set<string>();
    const boards = [...owned, ...memberBoards].filter((board) => {
      if (seen.has(board._id)) return false;
      seen.add(board._id);
      return true;
    });
    return boards.map((board) => ({
      boardId: board._id,
      title: board.title,
      // `isDefault` means "this caller's default". A shared board that is the
      // owner's default is not the member's default.
      isDefault: board.ownerUserId === userId ? board.isDefault : undefined,
      owned: board.ownerUserId === userId,
      hasPublicLink: Boolean(board.publicToken),
      updatedAt: board.updatedAt,
    }));
  },
});

// Activates email-only invites for the signed-in user; runs from the surface
// on load (queries cannot write).
export const claimInvites = mutation({
  args: { ...callerArgs },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const me = await ctx.db
      .query('users')
      .withIndex('by_clerk_user_id', (q) => q.eq('clerkUserId', userId))
      .first();
    if (!me?.email) return { claimed: 0 };
    const invites = await ctx.db
      .query('boardMembers')
      .withIndex('by_email', (q) => q.eq('email', me.email.toLowerCase()))
      .collect();
    let claimed = 0;
    for (const invite of invites) {
      if (invite.userId) continue;
      await ctx.db.patch(invite._id, { userId, status: 'active', updatedAt: now() });
      claimed += 1;
    }
    return { claimed };
  },
});

export const getBoard = query({
  args: { ...callerArgs, boardId: v.id('boards') },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const identity = await ctx.auth.getUserIdentity().catch(() => null);
    const { board, role } = await boardRole(ctx, args.boardId, userId, identity?.email as string | undefined);
    if (!board || !role) throw new Error('Board not found or access denied.');
    return boardPayload(ctx, board, role);
  },
});

// Token-gated read-only view; no identity involved. internalSecret is
// accepted (and ignored) because the server-side convexQuery helper always
// attaches it.
export const getPublicBoard = query({
  args: { token: v.string(), internalSecret: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (!args.token) return null;
    const board = await ctx.db
      .query('boards')
      .withIndex('by_public_token', (q) => q.eq('publicToken', args.token))
      .unique();
    if (!board) return null;
    return boardPayload(ctx, board, 'viewer');
  },
});

// Cards spawned from a given email thread — the provenance chip in the
// thread reader (mail → tasks direction).
export const liveCardsForThread = query({
  args: { ...callerArgs, threadId: v.string() },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    // An empty/missing thread id must not match anything — otherwise the
    // all-cards fallback below would surface unrelated cards on every email.
    if (!args.threadId) return [];
    const indexed = await ctx.db
      .query('cards')
      .withIndex('by_user_source_thread', (q) => q.eq('userId', userId).eq('sourceThreadId', args.threadId))
      .take(50);
    const rows = indexed.length
      ? indexed
      : await ctx.db
          .query('cards')
          .withIndex('by_user', (q) => q.eq('userId', userId))
          .take(1000);
    return rows
      .filter((card) => card.sourceThreadId === args.threadId || card.source?.threadId === args.threadId)
      .map((card) => ({ cardId: card._id, title: card.title, completedAt: card.completedAt }));
  },
});

// Cards spawned from a given calendar event — the provenance chip in the
// event viewer (calendar → tasks direction).
export const liveCardsForCalendarEvent = query({
  args: { ...callerArgs, eventId: v.string(), masterEventId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const wanted = new Set([args.eventId, args.masterEventId].filter(Boolean) as string[]);
    const byEvent = await Promise.all(
      [...wanted].map((eventId) =>
        ctx.db
          .query('cards')
          .withIndex('by_user_source_calendar_event', (q) =>
            q.eq('userId', userId).eq('sourceCalendarEventId', eventId),
          )
          .take(50),
      ),
    );
    const indexed = byEvent.flat();
    const rows = indexed.length
      ? indexed
      : await ctx.db
          .query('cards')
          .withIndex('by_user', (q) => q.eq('userId', userId))
          .take(1000);
    const seen = new Set<string>();
    return rows
      .filter((card) => {
        const sourceEventId =
          card.sourceCalendarEventId || card.source?.eventId || card.source?.providerEventId;
        return sourceEventId && wanted.has(sourceEventId);
      })
      .filter((card) => {
        if (seen.has(card._id)) return false;
        seen.add(card._id);
        return true;
      })
      .map((card) => ({ cardId: card._id, title: card.title, completedAt: card.completedAt }));
  },
});

// Cards with due dates, for the calendar's task lane.
export const listDueCards = query({
  args: { ...callerArgs, startAt: v.number(), endAt: v.number() },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const rows = await ctx.db
      .query('cards')
      .withIndex('by_user_due', (q) =>
        q.eq('userId', userId).gte('dueAt', args.startAt).lt('dueAt', args.endAt),
      )
      .take(1000);
    return rows
      .filter((card) => !card.retiredAt)
      .map((card) => ({ ...snapshotCard(card), cardId: card._id }));
  },
});

// Daily report context: open cards only, enriched with board and column labels
// for the renderer. Completed cards stay out of briefs once checked off.
export const listReportCards = query({
  args: {
    ...callerArgs,
    since: v.number(),
    endAt: v.number(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const cap = Math.min(Math.max(args.limit ?? 400, 1), 1000);
    // Every board the user can see, so cards other members made on a shared
    // board are included (TSK-3). Each board reads two bounded index ranges:
    // cards due in the window, and undated cards changed since `since`.
    const boardIds = await accessibleBoardIds(ctx, userId);
    const open = (q: any) =>
      q.and(q.eq(q.field('completedAt'), undefined), q.eq(q.field('retiredAt'), undefined));
    const perBoard = await Promise.all(
      boardIds.map(async (boardId) => {
        const [due, undated] = await Promise.all([
          ctx.db
            .query('cards')
            .withIndex('by_board_due', (q) =>
              q.eq('boardId', boardId).gte('dueAt', args.since).lt('dueAt', args.endAt),
            )
            .filter(open)
            .take(cap),
          ctx.db
            .query('cards')
            .withIndex('by_board_updatedAt', (q) => q.eq('boardId', boardId).gte('updatedAt', args.since))
            .order('desc')
            .filter((q) => q.and(open(q), q.eq(q.field('dueAt'), undefined)))
            .take(cap),
        ]);
        return [...due, ...undated];
      }),
    );
    const filtered = perBoard
      .flat()
      .sort((a, b) => {
        const aDue = a.dueAt ?? Number.POSITIVE_INFINITY;
        const bDue = b.dueAt ?? Number.POSITIVE_INFINITY;
        if (aDue !== bDue) return aDue - bDue;
        return b.updatedAt - a.updatedAt;
      })
      .slice(0, cap);

    const columnIds = [...new Set(filtered.map((card) => card.columnId))];
    const [boards, columns] = await Promise.all([
      Promise.all(boardIds.map((id) => ctx.db.get(id))),
      Promise.all(columnIds.map((id) => ctx.db.get(id))),
    ]);
    const boardsById = new Map(boards.filter(Boolean).map((board: any) => [board._id, board]));
    const columnsById = new Map(columns.filter(Boolean).map((column: any) => [column._id, column]));

    return filtered.map((card) => ({
      ...snapshotCard(card),
      cardId: card._id,
      boardTitle: boardsById.get(card.boardId)?.title,
      columnName: columnsById.get(card.columnId)?.name,
    }));
  },
});

async function accessibleBoardIds(ctx: QueryCtx, userId: string): Promise<Id<'boards'>[]> {
  const me = await ctx.db
    .query('users')
    .withIndex('by_clerk_user_id', (q) => q.eq('clerkUserId', userId))
    .first();
  const [owned, byUser, byEmail] = await Promise.all([
    ctx.db
      .query('boards')
      .withIndex('by_owner', (q) => q.eq('ownerUserId', userId))
      .collect(),
    ctx.db
      .query('boardMembers')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect(),
    me?.email
      ? ctx.db
          .query('boardMembers')
          .withIndex('by_email', (q) => q.eq('email', me.email.toLowerCase()))
          .collect()
      : Promise.resolve([]),
  ]);
  const ids = new Map<string, Id<'boards'>>();
  for (const board of owned) ids.set(String(board._id), board._id);
  for (const member of [...byUser, ...byEmail]) ids.set(String(member.boardId), member.boardId);
  return [...ids.values()];
}

async function boardPayload(ctx: QueryCtx | MutationCtx, board: any, role: Role) {
  const [columns, cards, members] = await Promise.all([
    ctx.db
      .query('boardColumns')
      .withIndex('by_board', (q) => q.eq('boardId', board._id))
      .collect(),
    ctx.db
      .query('cards')
      .withIndex('by_board', (q) => q.eq('boardId', board._id))
      .collect(),
    ctx.db
      .query('boardMembers')
      .withIndex('by_board', (q) => q.eq('boardId', board._id))
      .collect(),
  ]);
  columns.sort((a, b) => a.order - b.order);
  cards.sort((a, b) => a.order - b.order);
  const ownerEmail = await actorEmail(ctx, board.ownerUserId);
  const cardPayloads = await Promise.all(
    cards
      .filter((card) => !card.retiredAt)
      .map(async (card) => ({
        cardId: card._id,
        ...snapshotCard(card),
        attachments: await resolveAttachments(ctx, card.attachments),
      })),
  );
  return {
    boardId: board._id,
    title: board.title,
    role,
    publicToken: role === 'owner' ? board.publicToken || null : null,
    ownerEmail,
    columns: columns.map((column) => ({ columnId: column._id, name: column.name, order: column.order })),
    cards: cardPayloads,
    // Member management stays owner-only, but everyone who can edit needs the
    // roster to pick assignees, so expose the lightweight list to non-viewers.
    members:
      role === 'viewer'
        ? []
        : members.map((member) => ({
            memberId: member._id,
            email: member.email,
            role: member.role,
            status: member.status,
          })),
  };
}

// Uploaded attachments store a Convex storage id; the browser needs a URL.
async function resolveAttachments(ctx: QueryCtx | MutationCtx, attachments: any[] | undefined) {
  if (!attachments?.length) return attachments;
  return Promise.all(
    attachments.map(async (attachment) => {
      if (attachment.url || !attachment.storageId) return attachment;
      const url = await ctx.storage.getUrl(attachment.storageId).catch(() => null);
      return { ...attachment, url: url || undefined };
    }),
  );
}

function snapshotCard(card: any) {
  return {
    boardId: card.boardId,
    columnId: card.columnId,
    title: card.title,
    description: card.description,
    labels: card.labels,
    priority: card.priority,
    weight: card.weight,
    assignees: card.assignees,
    dueAt: card.dueAt,
    completedAt: card.completedAt,
    order: card.order,
    attachments: card.attachments,
    comments: card.comments,
    activity: card.activity,
    source: card.source,
    sourceThreadId: card.sourceThreadId,
    sourceCalendarEventId: card.sourceCalendarEventId,
    sourceAccountId: card.sourceAccountId,
  };
}

async function cardStatePayload(ctx: QueryCtx | MutationCtx, card: any) {
  const [board, column] = (await Promise.all([ctx.db.get(card.boardId), ctx.db.get(card.columnId)])) as any[];
  return {
    cardId: card._id,
    ...snapshotCard(card),
    attachments: await resolveAttachments(ctx, card.attachments),
    boardTitle: board?.title ?? null,
    columnName: column?.name ?? null,
    completed: Boolean(card.completedAt),
    completedAt: card.completedAt ?? null,
  };
}
