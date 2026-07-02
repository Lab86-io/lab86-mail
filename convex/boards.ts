import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { mutation, query } from './_generated/server';
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

export const ensureDefaultBoard = mutation({
  args: { ...callerArgs },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const owned = await ctx.db
      .query('boards')
      .withIndex('by_owner', (q) => q.eq('ownerUserId', userId))
      .collect();
    if (owned.length) return owned[0]._id;
    const ts = now();
    const boardId = await ctx.db.insert('boards', {
      ownerUserId: userId,
      title: 'Personal',
      isDefault: true,
      createdAt: ts,
      updatedAt: ts,
    });
    for (let i = 0; i < STARTER_COLUMNS.length; i += 1) {
      await ctx.db.insert('boardColumns', {
        boardId,
        name: STARTER_COLUMNS[i],
        order: (i + 1) * ORDER_STEP,
        createdAt: ts,
        updatedAt: ts,
      });
    }
    return boardId;
  },
});

export const createBoard = mutation({
  args: { ...callerArgs, title: v.string(), columns: v.optional(v.array(v.string())) },
  handler: async (ctx, args) => {
    const userId = await resolveUserId(ctx, args);
    const ts = now();
    const boardId = await ctx.db.insert('boards', {
      ownerUserId: userId,
      title: args.title.trim() || 'Untitled board',
      createdAt: ts,
      updatedAt: ts,
    });
    const columns = args.columns?.length ? args.columns : STARTER_COLUMNS;
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
      attachments: args.attachments,
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
    if (args.attachments !== undefined) patch.attachments = args.attachments;
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
      if (!card.completedAt) movePatch.completedAt = now();
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
    await ctx.db.patch(args.cardId, {
      attachments: [
        ...(card.attachments || []),
        {
          name: args.name.trim() || args.url || 'attachment',
          url: args.url,
          storageId: args.storageId,
          contentType: args.contentType,
          size: args.size,
        },
      ],
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
      isDefault: board.isDefault,
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
  args: { threadId: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity?.subject) throw new Error('Not authenticated');
    // An empty/missing thread id must not match anything — otherwise the
    // all-cards fallback below would surface unrelated cards on every email.
    if (!args.threadId) return [];
    const indexed = await ctx.db
      .query('cards')
      .withIndex('by_user_source_thread', (q) =>
        q.eq('userId', identity.subject).eq('sourceThreadId', args.threadId),
      )
      .take(50);
    const rows = indexed.length
      ? indexed
      : await ctx.db
          .query('cards')
          .withIndex('by_user', (q) => q.eq('userId', identity.subject))
          .take(1000);
    return rows
      .filter((card) => card.sourceThreadId === args.threadId || card.source?.threadId === args.threadId)
      .map((card) => ({ cardId: card._id, title: card.title, completedAt: card.completedAt }));
  },
});

// Cards spawned from a given calendar event — the provenance chip in the
// event viewer (calendar → tasks direction).
export const liveCardsForCalendarEvent = query({
  args: { eventId: v.string(), masterEventId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity?.subject) throw new Error('Not authenticated');
    const wanted = new Set([args.eventId, args.masterEventId].filter(Boolean) as string[]);
    const byEvent = await Promise.all(
      [...wanted].map((eventId) =>
        ctx.db
          .query('cards')
          .withIndex('by_user_source_calendar_event', (q) =>
            q.eq('userId', identity.subject).eq('sourceCalendarEventId', eventId),
          )
          .take(50),
      ),
    );
    const indexed = byEvent.flat();
    const rows = indexed.length
      ? indexed
      : await ctx.db
          .query('cards')
          .withIndex('by_user', (q) => q.eq('userId', identity.subject))
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
    return rows.map((card) => ({ ...snapshotCard(card), cardId: card._id }));
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
    const rows = await ctx.db
      .query('cards')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .take(cap);
    const filtered = rows
      .filter((card) => {
        return !card.completedAt;
      })
      .sort((a, b) => {
        const aDone = a.completedAt ? 1 : 0;
        const bDone = b.completedAt ? 1 : 0;
        if (aDone !== bDone) return aDone - bDone;
        const aDue = a.dueAt ?? Number.POSITIVE_INFINITY;
        const bDue = b.dueAt ?? Number.POSITIVE_INFINITY;
        if (aDue !== bDue) return aDue - bDue;
        return b.updatedAt - a.updatedAt;
      })
      .slice(0, cap);

    const boardIds = [...new Set(filtered.map((card) => card.boardId))];
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
    cards.map(async (card) => ({
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
    boardTitle: board?.title ?? null,
    columnName: column?.name ?? null,
    completed: Boolean(card.completedAt),
    completedAt: card.completedAt ?? null,
  };
}
