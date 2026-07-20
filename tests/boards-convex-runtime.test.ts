import { describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import schema from '../convex/schema';

const convexModules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/boards.ts': () => import('../convex/boards'),
  '../convex/albatrossWork.ts': () => import('../convex/albatrossWork'),
};

const STARTER_COLUMNS = ['Today', 'This Week', 'Backlog', 'Done'];

function makeHarness() {
  const t = convexTest(schema, convexModules);
  const owner = t.withIdentity({ subject: 'user_owner', email: 'owner@example.com' });
  return { t, owner };
}

async function seedUser(t: ReturnType<typeof convexTest>, clerkUserId: string, email: string) {
  const ts = Date.now();
  await t.run((ctx) => ctx.db.insert('users', { clerkUserId, email, createdAt: ts, updatedAt: ts }));
}

async function boardColumns(t: ReturnType<typeof convexTest>, boardId: Id<'boards'>) {
  const columns = await t.run((ctx) =>
    ctx.db
      .query('boardColumns')
      .withIndex('by_board', (q) => q.eq('boardId', boardId))
      .collect(),
  );
  return columns.sort((a, b) => a.order - b.order);
}

describe('boards Convex runtime', () => {
  test('ensureDefaultBoard creates Personal with starter columns exactly once', async () => {
    const { t, owner } = makeHarness();
    const boardId = await owner.mutation(api.boards.ensureDefaultBoard, {});
    const again = await owner.mutation(api.boards.ensureDefaultBoard, {});
    expect(again).toBe(boardId);

    const boards = await t.run((ctx) => ctx.db.query('boards').collect());
    expect(boards).toHaveLength(1);
    expect(boards[0]).toMatchObject({ ownerUserId: 'user_owner', title: 'Personal', isDefault: true });
    const columns = await boardColumns(t, boardId);
    expect(columns.map((column) => column.name)).toEqual(STARTER_COLUMNS);
    expect(columns.map((column) => column.order)).toEqual([1024, 2048, 3072, 4096]);
  });

  test('createBoard honors custom columns; renameBoard is owner-only; deleteBoard cascades', async () => {
    const { t, owner } = makeHarness();
    await seedUser(t, 'user_member', 'member@example.com');
    const member = t.withIdentity({ subject: 'user_member', email: 'member@example.com' });

    const opsId = await owner.mutation(api.boards.createBoard, {
      title: '  Ops  ',
      columns: ['Now', 'Later'],
    });
    const untitledId = await owner.mutation(api.boards.createBoard, { title: '   ' });
    expect((await t.run((ctx) => ctx.db.get(opsId)))?.title).toBe('Ops');
    expect((await t.run((ctx) => ctx.db.get(untitledId)))?.title).toBe('Untitled board');
    expect((await boardColumns(t, opsId)).map((column) => column.name)).toEqual(['Now', 'Later']);
    expect((await boardColumns(t, untitledId)).map((column) => column.name)).toEqual(STARTER_COLUMNS);

    await owner.mutation(api.boards.inviteMember, {
      boardId: opsId,
      email: 'member@example.com',
      role: 'member',
    });
    await expect(
      member.mutation(api.boards.renameBoard, { boardId: opsId, title: 'Hijacked' }),
    ).rejects.toThrow('Board not found or access denied.');
    await owner.mutation(api.boards.renameBoard, { boardId: opsId, title: '  Renamed Ops ' });
    expect((await t.run((ctx) => ctx.db.get(opsId)))?.title).toBe('Renamed Ops');

    const opsColumns = await boardColumns(t, opsId);
    await owner.mutation(api.boards.createCard, {
      boardId: opsId,
      columnId: opsColumns[0]._id,
      title: 'Doomed card',
    });
    await owner.mutation(api.boards.deleteBoard, { boardId: opsId });
    expect(await t.run((ctx) => ctx.db.get(opsId))).toBeNull();
    expect(await boardColumns(t, opsId)).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query('cards').collect())).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query('boardMembers').collect())).toHaveLength(0);
    // The untouched board survives the cascade.
    expect(await t.run((ctx) => ctx.db.get(untitledId))).not.toBeNull();
  });

  test('internal-secret callers act as an explicit user; anonymous callers are rejected', async () => {
    const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'boards-server-secret';
    try {
      const { t } = makeHarness();
      const boardId = await t.mutation(api.boards.createBoard, {
        internalSecret: 'boards-server-secret',
        userId: 'user_server',
        title: 'Server board',
      });
      expect((await t.run((ctx) => ctx.db.get(boardId)))?.ownerUserId).toBe('user_server');

      await expect(
        t.mutation(api.boards.createBoard, { internalSecret: 'boards-server-secret', title: 'No user' }),
      ).rejects.toThrow('userId required with internal secret.');
      await expect(
        t.mutation(api.boards.createBoard, { internalSecret: 'wrong-secret', userId: 'x', title: 'Nope' }),
      ).rejects.toThrow('Invalid Convex internal secret.');
      await expect(t.mutation(api.boards.createBoard, { title: 'Anonymous' })).rejects.toThrow(
        'Not authenticated',
      );
    } finally {
      if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
    }
  });

  test('columns append in order, rename defensively, and delete with their cards', async () => {
    const { t, owner } = makeHarness();
    const boardId = await owner.mutation(api.boards.ensureDefaultBoard, {});
    const columnId = await owner.mutation(api.boards.createColumn, { boardId, name: '   ' });
    const created = await t.run((ctx) => ctx.db.get(columnId));
    expect(created).toMatchObject({ name: 'Untitled', order: 5120 });

    await owner.mutation(api.boards.updateColumn, { columnId, name: '', order: 512 });
    const renamed = await t.run((ctx) => ctx.db.get(columnId));
    // Blank names keep the previous name; the order still moves.
    expect(renamed).toMatchObject({ name: 'Untitled', order: 512 });
    await owner.mutation(api.boards.updateColumn, { columnId, name: ' Triage ' });
    expect((await t.run((ctx) => ctx.db.get(columnId)))?.name).toBe('Triage');

    const cardId = await owner.mutation(api.boards.createCard, { boardId, columnId, title: 'In triage' });
    await owner.mutation(api.boards.deleteColumn, { columnId });
    expect(await t.run((ctx) => ctx.db.get(columnId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(cardId))).toBeNull();
    await expect(owner.mutation(api.boards.updateColumn, { columnId, name: 'Ghost' })).rejects.toThrow(
      'Column not found.',
    );
    await expect(owner.mutation(api.boards.deleteColumn, { columnId })).rejects.toThrow('Column not found.');

    const stranger = t.withIdentity({ subject: 'user_stranger', email: 'stranger@example.com' });
    await expect(stranger.mutation(api.boards.createColumn, { boardId, name: 'Sneaky' })).rejects.toThrow(
      'Board not found or access denied.',
    );
  });

  test('createCard validates the column and normalizes assignees against the roster', async () => {
    const { t, owner } = makeHarness();
    await seedUser(t, 'user_owner', 'owner@example.com');
    await seedUser(t, 'user_member', 'member@example.com');
    const boardId = await owner.mutation(api.boards.ensureDefaultBoard, {});
    const [today] = await boardColumns(t, boardId);
    await owner.mutation(api.boards.inviteMember, {
      boardId,
      email: 'member@example.com',
      role: 'member',
    });

    const firstId = await owner.mutation(api.boards.createCard, {
      boardId,
      columnId: today._id,
      title: '  Ship it  ',
      source: { threadId: 'th_1', accountId: 'acc_1' },
      assignees: [' Member@Example.com ', 'OWNER@example.com'],
    });
    const first = await t.run((ctx) => ctx.db.get(firstId));
    expect(first).toMatchObject({
      title: 'Ship it',
      order: 1024,
      sourceThreadId: 'th_1',
      sourceAccountId: 'acc_1',
      assignees: ['member@example.com', 'owner@example.com'],
    });
    expect(first?.activity?.map((entry) => entry.action)).toEqual(['created']);

    const secondId = await owner.mutation(api.boards.createCard, {
      boardId,
      columnId: today._id,
      title: '',
      assignees: [],
    });
    const second = await t.run((ctx) => ctx.db.get(secondId));
    expect(second).toMatchObject({ title: 'Untitled card', order: 2048, assignees: [] });

    await expect(
      owner.mutation(api.boards.createCard, {
        boardId,
        columnId: today._id,
        title: 'Bad assignee',
        assignees: ['nobody@example.com'],
      }),
    ).rejects.toThrow('Assignee "nobody@example.com" is not a member of this board.');

    const otherBoardId = await owner.mutation(api.boards.createBoard, { title: 'Other' });
    const [otherColumn] = await boardColumns(t, otherBoardId);
    await expect(
      owner.mutation(api.boards.createCard, { boardId, columnId: otherColumn._id, title: 'Cross board' }),
    ).rejects.toThrow('Column not found on board.');
  });

  test('updateCard completion flips into Done, records one completion event, and reopening moves out', async () => {
    const { t, owner } = makeHarness();
    const boardId = await owner.mutation(api.boards.ensureDefaultBoard, {});
    const columns = await boardColumns(t, boardId);
    const today = columns[0];
    const done = columns.find((column) => column.name === 'Done')!;
    const dueAt = Date.now() + 86_400_000;
    const cardId = await owner.mutation(api.boards.createCard, {
      boardId,
      columnId: today._id,
      title: 'Finish taxes',
      dueAt,
      weight: 3,
    });

    const completedAt = Date.now();
    const completed = await owner.mutation(api.boards.updateCard, { cardId, completedAt });
    expect(completed.previous.columnId).toBe(today._id);
    expect(completed.previous.completedAt).toBeUndefined();
    expect(completed.card).toMatchObject({
      columnId: done._id,
      columnName: 'Done',
      boardTitle: 'Personal',
      completed: true,
      completedAt,
    });
    const events = await t.run((ctx) => ctx.db.query('completionEvents').collect());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      userId: 'user_owner',
      artifactKind: 'task',
      artifactId: String(cardId),
      completedAt,
      dueAt,
      completedEarlyByMs: dueAt - completedAt,
    });

    // Completing an already-completed card records no second event.
    await owner.mutation(api.boards.updateCard, { cardId, completedAt: completedAt + 5 });
    expect(await t.run((ctx) => ctx.db.query('completionEvents').collect())).toHaveLength(1);

    const reopened = await owner.mutation(api.boards.updateCard, { cardId, completedAt: null });
    expect(reopened.card).toMatchObject({ columnId: today._id, completed: false, completedAt: null });
    // History is append-only: reopening keeps the recorded completion.
    expect(await t.run((ctx) => ctx.db.query('completionEvents').collect())).toHaveLength(1);

    const patched = await owner.mutation(api.boards.updateCard, {
      cardId,
      title: '   ',
      description: 'Q2 filing',
      labels: ['finance'],
      priority: 'high',
      weight: null,
      dueAt: null,
    });
    // A blank title keeps the previous one; null clears weight and dueAt.
    expect(patched.card).toMatchObject({
      title: 'Finish taxes',
      description: 'Q2 filing',
      labels: ['finance'],
      priority: 'high',
    });
    expect(patched.card.weight).toBeUndefined();
    expect(patched.card.dueAt).toBeUndefined();

    await owner.mutation(api.boards.deleteCard, { cardId });
    await expect(owner.mutation(api.boards.updateCard, { cardId, title: 'Ghost' })).rejects.toThrow(
      'Card not found.',
    );
  });

  test('completion toggle still works on boards without a Done column', async () => {
    const { t, owner } = makeHarness();
    const boardId = await owner.mutation(api.boards.createBoard, { title: 'Flat', columns: ['Only'] });
    const [only] = await boardColumns(t, boardId);
    const cardId = await owner.mutation(api.boards.createCard, {
      boardId,
      columnId: only._id,
      title: 'Task',
    });

    const completed = await owner.mutation(api.boards.updateCard, { cardId, completedAt: Date.now() });
    expect(completed.card).toMatchObject({ columnId: only._id, completed: true });
    const reopened = await owner.mutation(api.boards.updateCard, { cardId, completedAt: null });
    expect(reopened.card).toMatchObject({ columnId: only._id, completed: false });
  });

  test('moveCard orders by neighbours, renumbers exhausted midpoints, and syncs Done state', async () => {
    const { t, owner } = makeHarness();
    const boardId = await owner.mutation(api.boards.ensureDefaultBoard, {});
    const columns = await boardColumns(t, boardId);
    const today = columns[0];
    const thisWeek = columns[1];
    const backlog = columns[2];
    const done = columns.find((column) => column.name === 'Done')!;
    const create = (columnId: Id<'boardColumns'>, title: string) =>
      owner.mutation(api.boards.createCard, { boardId, columnId, title });
    const cardA = await create(today._id, 'A');
    const cardB = await create(today._id, 'B');
    const cardC = await create(today._id, 'C');

    // Drop C between A (1024) and B (2048): midpoint.
    const between = await owner.mutation(api.boards.moveCard, {
      cardId: cardC,
      columnId: today._id,
      beforeOrder: 1024,
      afterOrder: 2048,
    });
    expect(between.previous.order).toBe(3072);
    expect(between.card.order).toBe(1536);

    // Append to an empty column, then place relative to a single neighbour.
    const appended = await owner.mutation(api.boards.moveCard, { cardId: cardA, columnId: thisWeek._id });
    expect(appended.card).toMatchObject({ columnId: thisWeek._id, order: 1024 });
    const after = await owner.mutation(api.boards.moveCard, {
      cardId: cardA,
      columnId: thisWeek._id,
      beforeOrder: 1024,
    });
    expect(after.card.order).toBe(2048);
    const before = await owner.mutation(api.boards.moveCard, {
      cardId: cardA,
      columnId: thisWeek._id,
      afterOrder: 2048,
    });
    expect(before.card.order).toBe(1024);
    const movedActivity = (await t.run((ctx) => ctx.db.get(cardA)))?.activity ?? [];
    expect(movedActivity.at(-1)).toMatchObject({ action: 'moved', detail: 'to This Week' });

    // Exhausted midpoint: identical neighbour orders force a renumber of the
    // destination column, then the card lands between the new orders.
    const cardD = await create(backlog._id, 'D');
    const cardE = await create(backlog._id, 'E');
    const renumbered = await owner.mutation(api.boards.moveCard, {
      cardId: cardB,
      columnId: backlog._id,
      beforeOrder: 1024,
      afterOrder: 1024,
    });
    expect(renumbered.card).toMatchObject({ columnId: backlog._id, order: 1536 });
    expect((await t.run((ctx) => ctx.db.get(cardD)))?.order).toBe(1024);
    expect((await t.run((ctx) => ctx.db.get(cardE)))?.order).toBe(2048);

    // Dragging into Done completes; dragging out reopens.
    const intoDone = await owner.mutation(api.boards.moveCard, { cardId: cardC, columnId: done._id });
    expect(typeof intoDone.card.completedAt).toBe('number');
    expect(intoDone.card.completed).toBe(true);
    expect(await t.run((ctx) => ctx.db.query('completionEvents').collect())).toHaveLength(1);
    const outOfDone = await owner.mutation(api.boards.moveCard, { cardId: cardC, columnId: today._id });
    expect(outOfDone.card.completedAt).toBeNull();
    expect(outOfDone.card.completed).toBe(false);
    expect(await t.run((ctx) => ctx.db.query('completionEvents').collect())).toHaveLength(1);

    const foreignBoard = await owner.mutation(api.boards.createBoard, { title: 'Elsewhere' });
    const [foreignColumn] = await boardColumns(t, foreignBoard);
    await expect(
      owner.mutation(api.boards.moveCard, { cardId: cardB, columnId: foreignColumn._id }),
    ).rejects.toThrow('Column not found on board.');
    await owner.mutation(api.boards.deleteCard, { cardId: cardB });
    await expect(owner.mutation(api.boards.moveCard, { cardId: cardB, columnId: today._id })).rejects.toThrow(
      'Card not found.',
    );
  });

  test('getCardState requires viewer access and getCardStates skips inaccessible cards', async () => {
    const { t, owner } = makeHarness();
    await seedUser(t, 'user_viewer', 'viewer@example.com');
    const boardId = await owner.mutation(api.boards.ensureDefaultBoard, {});
    const [today] = await boardColumns(t, boardId);
    const ownerCard = await owner.mutation(api.boards.createCard, {
      boardId,
      columnId: today._id,
      title: 'Owner card',
    });
    await owner.mutation(api.boards.inviteMember, {
      boardId,
      email: 'viewer@example.com',
      role: 'viewer',
    });

    const viewer = t.withIdentity({ subject: 'user_viewer', email: 'viewer@example.com' });
    const state = await viewer.query(api.boards.getCardState, { cardId: ownerCard });
    expect(state).toMatchObject({
      title: 'Owner card',
      boardTitle: 'Personal',
      columnName: 'Today',
      completed: false,
      completedAt: null,
    });

    const stranger = t.withIdentity({ subject: 'user_stranger', email: 'stranger@example.com' });
    await expect(stranger.query(api.boards.getCardState, { cardId: ownerCard })).rejects.toThrow(
      'Board not found or access denied.',
    );

    const strangerBoard = await stranger.mutation(api.boards.createBoard, { title: 'Mine' });
    const [strangerColumn] = await boardColumns(t, strangerBoard);
    const strangerCard = await stranger.mutation(api.boards.createCard, {
      boardId: strangerBoard,
      columnId: strangerColumn._id,
      title: 'My card',
    });
    const deletedCard = await stranger.mutation(api.boards.createCard, {
      boardId: strangerBoard,
      columnId: strangerColumn._id,
      title: 'Gone',
    });
    await stranger.mutation(api.boards.deleteCard, { cardId: deletedCard });

    const states = await stranger.query(api.boards.getCardStates, {
      cardIds: [String(strangerCard), String(ownerCard), 'not-a-card-id', String(deletedCard)],
    });
    expect(states).toEqual([{ cardId: String(strangerCard), completedAt: null }]);
  });

  test('addComment lets viewers post trimmed comments; deleteCard returns a snapshot', async () => {
    const { t, owner } = makeHarness();
    await seedUser(t, 'user_viewer', 'viewer@example.com');
    const boardId = await owner.mutation(api.boards.ensureDefaultBoard, {});
    const [today] = await boardColumns(t, boardId);
    const cardId = await owner.mutation(api.boards.createCard, {
      boardId,
      columnId: today._id,
      title: 'Discussable',
    });
    await owner.mutation(api.boards.inviteMember, {
      boardId,
      email: 'viewer@example.com',
      role: 'viewer',
    });

    const viewer = t.withIdentity({ subject: 'user_viewer', email: 'viewer@example.com' });
    const comment = await viewer.mutation(api.boards.addComment, { cardId, body: '  Looks good  ' });
    expect(comment).toMatchObject({
      body: 'Looks good',
      authorUserId: 'user_viewer',
      authorEmail: 'viewer@example.com',
    });
    const card = await t.run((ctx) => ctx.db.get(cardId));
    expect(card?.comments).toHaveLength(1);
    expect(card?.activity?.map((entry) => entry.action)).toEqual(['created', 'commented']);

    await expect(viewer.mutation(api.boards.addComment, { cardId, body: '    ' })).rejects.toThrow(
      'Comment is empty.',
    );

    const deleted = await owner.mutation(api.boards.deleteCard, { cardId });
    expect(deleted.previous).toMatchObject({ title: 'Discussable', columnId: today._id });
    expect(await t.run((ctx) => ctx.db.get(cardId))).toBeNull();
    await expect(owner.mutation(api.boards.deleteCard, { cardId })).rejects.toThrow('Card not found.');
  });

  test('attachToCard requires a target and upload URLs authorize against the board', async () => {
    const { t, owner } = makeHarness();
    const boardId = await owner.mutation(api.boards.ensureDefaultBoard, {});
    const [today] = await boardColumns(t, boardId);
    const cardId = await owner.mutation(api.boards.createCard, {
      boardId,
      columnId: today._id,
      title: 'Has files',
    });

    await expect(owner.mutation(api.boards.attachToCard, { cardId, name: 'empty' })).rejects.toThrow(
      'url or storageId required.',
    );
    const attached = await owner.mutation(api.boards.attachToCard, {
      cardId,
      name: '  ',
      url: 'https://example.com/doc.pdf',
    });
    expect(attached.ok).toBe(true);
    const card = await t.run((ctx) => ctx.db.get(cardId));
    expect(card?.attachments).toEqual([
      { name: 'https://example.com/doc.pdf', url: 'https://example.com/doc.pdf' },
    ]);
    expect(card?.activity?.at(-1)).toMatchObject({ action: 'attached' });

    await expect(owner.mutation(api.boards.generateAttachmentUploadUrl, {})).rejects.toThrow(
      'cardId or boardId required.',
    );
    const uploadUrl = await owner.mutation(api.boards.generateAttachmentUploadUrl, { cardId });
    expect(typeof uploadUrl).toBe('string');
    expect(uploadUrl.length).toBeGreaterThan(0);
  });

  test('setPublicLink gates on a token and getPublicBoard serves a read-only viewer payload', async () => {
    const { t, owner } = makeHarness();
    await seedUser(t, 'user_member', 'member@example.com');
    const boardId = await owner.mutation(api.boards.ensureDefaultBoard, {});
    await owner.mutation(api.boards.inviteMember, {
      boardId,
      email: 'member@example.com',
      role: 'member',
    });

    await expect(owner.mutation(api.boards.setPublicLink, { boardId, enabled: true })).rejects.toThrow(
      'token required to enable the public link.',
    );
    const member = t.withIdentity({ subject: 'user_member', email: 'member@example.com' });
    await expect(
      member.mutation(api.boards.setPublicLink, { boardId, enabled: true, token: 'nope' }),
    ).rejects.toThrow('Board not found or access denied.');

    const enabled = await owner.mutation(api.boards.setPublicLink, {
      boardId,
      enabled: true,
      token: 'tok_123',
    });
    expect(enabled).toEqual({ publicToken: 'tok_123' });

    const shared = await t.query(api.boards.getPublicBoard, { token: 'tok_123' });
    expect(shared).toMatchObject({ title: 'Personal', role: 'viewer', publicToken: null, members: [] });
    expect(shared?.columns.map((column: { name: string }) => column.name)).toEqual(STARTER_COLUMNS);
    expect(await t.query(api.boards.getPublicBoard, { token: '' })).toBeNull();
    expect(await t.query(api.boards.getPublicBoard, { token: 'wrong' })).toBeNull();

    const disabled = await owner.mutation(api.boards.setPublicLink, { boardId, enabled: false });
    expect(disabled).toEqual({ publicToken: null });
    expect(await t.query(api.boards.getPublicBoard, { token: 'tok_123' })).toBeNull();
  });

  test('inviteMember links known users, dedupes, and removeMember enforces owner-or-self', async () => {
    const { t, owner } = makeHarness();
    await seedUser(t, 'user_member', 'member@example.com');
    await seedUser(t, 'user_viewer', 'viewer@example.com');
    const boardId = await owner.mutation(api.boards.ensureDefaultBoard, {});

    await expect(
      owner.mutation(api.boards.inviteMember, { boardId, email: 'not-an-email', role: 'member' }),
    ).rejects.toThrow('Invalid email.');

    const memberId = await owner.mutation(api.boards.inviteMember, {
      boardId,
      email: ' Member@Example.COM ',
      role: 'member',
    });
    expect(await t.run((ctx) => ctx.db.get(memberId))).toMatchObject({
      email: 'member@example.com',
      userId: 'user_member',
      status: 'active',
      role: 'member',
    });

    // Re-inviting the same email updates the role in place.
    const duplicateId = await owner.mutation(api.boards.inviteMember, {
      boardId,
      email: 'member@example.com',
      role: 'viewer',
    });
    expect(duplicateId).toBe(memberId);
    expect((await t.run((ctx) => ctx.db.get(memberId)))?.role).toBe('viewer');

    const ghostId = await owner.mutation(api.boards.inviteMember, {
      boardId,
      email: 'ghost@example.com',
      role: 'viewer',
    });
    const ghost = await t.run((ctx) => ctx.db.get(ghostId));
    expect(ghost).toMatchObject({ status: 'invited' });
    expect(ghost?.userId).toBeUndefined();

    const viewerId = await owner.mutation(api.boards.inviteMember, {
      boardId,
      email: 'viewer@example.com',
      role: 'viewer',
    });
    const viewer = t.withIdentity({ subject: 'user_viewer', email: 'viewer@example.com' });
    await expect(viewer.mutation(api.boards.removeMember, { boardId, memberId })).rejects.toThrow(
      'Access denied.',
    );
    // Members may leave on their own.
    await viewer.mutation(api.boards.removeMember, { boardId, memberId: viewerId });
    expect(await t.run((ctx) => ctx.db.get(viewerId))).toBeNull();
    await owner.mutation(api.boards.removeMember, { boardId, memberId: ghostId });
    expect(await t.run((ctx) => ctx.db.get(ghostId))).toBeNull();

    const otherBoard = await owner.mutation(api.boards.createBoard, { title: 'Other' });
    await expect(owner.mutation(api.boards.removeMember, { boardId: otherBoard, memberId })).rejects.toThrow(
      'Member not found.',
    );
  });

  test('claimInvites activates email-only invites for the signed-in user', async () => {
    const { t, owner } = makeHarness();
    const boardId = await owner.mutation(api.boards.ensureDefaultBoard, {});
    const inviteId = await owner.mutation(api.boards.inviteMember, {
      boardId,
      email: 'late@example.com',
      role: 'member',
    });
    expect((await t.run((ctx) => ctx.db.get(inviteId)))?.status).toBe('invited');

    const nobody = t.withIdentity({ subject: 'user_nobody', email: 'nobody@example.com' });
    expect(await nobody.mutation(api.boards.claimInvites, {})).toEqual({ claimed: 0 });

    await seedUser(t, 'user_late', 'late@example.com');
    const late = t.withIdentity({ subject: 'user_late', email: 'late@example.com' });
    expect(await late.mutation(api.boards.claimInvites, {})).toEqual({ claimed: 1 });
    expect(await t.run((ctx) => ctx.db.get(inviteId))).toMatchObject({
      userId: 'user_late',
      status: 'active',
    });
    // Already-linked invites are not claimed twice.
    expect(await late.mutation(api.boards.claimInvites, {})).toEqual({ claimed: 0 });
  });

  test('getBoard grants roles by userId or identity email and hides the roster from viewers', async () => {
    const { t, owner } = makeHarness();
    await seedUser(t, 'user_owner', 'owner@example.com');
    await seedUser(t, 'user_viewer', 'viewer@example.com');
    const boardId = await owner.mutation(api.boards.ensureDefaultBoard, {});
    await owner.mutation(api.boards.setPublicLink, { boardId, enabled: true, token: 'tok_owner' });
    await owner.mutation(api.boards.inviteMember, { boardId, email: 'shared@example.com', role: 'member' });
    await owner.mutation(api.boards.inviteMember, { boardId, email: 'viewer@example.com', role: 'viewer' });
    const [today] = await boardColumns(t, boardId);
    await owner.mutation(api.boards.createCard, {
      boardId,
      columnId: today._id,
      title: 'Linked',
      attachments: [{ name: 'spec', url: 'https://example.com/spec.html' }],
    });

    const ownerView = await owner.query(api.boards.getBoard, { boardId });
    expect(ownerView).toMatchObject({
      role: 'owner',
      publicToken: 'tok_owner',
      ownerEmail: 'owner@example.com',
    });
    expect(ownerView.members.map((member: { email: string }) => member.email).sort()).toEqual([
      'shared@example.com',
      'viewer@example.com',
    ]);
    expect(ownerView.cards).toHaveLength(1);
    expect(ownerView.cards[0].attachments).toEqual([{ name: 'spec', url: 'https://example.com/spec.html' }]);

    // No linked userId on the membership — access resolves via identity email,
    // case-insensitively.
    const emailOnly = t.withIdentity({ subject: 'user_shared', email: 'Shared@Example.com' });
    const sharedView = await emailOnly.query(api.boards.getBoard, { boardId });
    expect(sharedView).toMatchObject({ role: 'member', publicToken: null });
    expect(sharedView.members.length).toBe(2);

    const viewer = t.withIdentity({ subject: 'user_viewer', email: 'viewer@example.com' });
    const viewerView = await viewer.query(api.boards.getBoard, { boardId });
    expect(viewerView).toMatchObject({ role: 'viewer', publicToken: null, members: [] });

    const stranger = t.withIdentity({ subject: 'user_stranger', email: 'stranger@example.com' });
    await expect(stranger.query(api.boards.getBoard, { boardId })).rejects.toThrow(
      'Board not found or access denied.',
    );
  });

  test('listMyBoards merges owned and member boards without duplicates', async () => {
    const { t, owner } = makeHarness();
    await seedUser(t, 'user_member', 'member@example.com');
    const boardId = await owner.mutation(api.boards.ensureDefaultBoard, {});
    await owner.mutation(api.boards.setPublicLink, { boardId, enabled: true, token: 'tok_list' });
    await owner.mutation(api.boards.inviteMember, { boardId, email: 'member@example.com', role: 'member' });
    // A second, unlinked invite row for the same email must not duplicate the board.
    const ts = Date.now();
    await t.run((ctx) =>
      ctx.db.insert('boardMembers', {
        boardId,
        email: 'member@example.com',
        role: 'viewer',
        invitedBy: 'user_owner',
        status: 'invited',
        createdAt: ts,
        updatedAt: ts,
      }),
    );

    const member = t.withIdentity({ subject: 'user_member', email: 'member@example.com' });
    const memberBoardId = await member.mutation(api.boards.createBoard, { title: 'Side project' });
    const mine = await member.query(api.boards.listMyBoards, {});
    expect(mine).toHaveLength(2);
    expect(mine.find((board) => board.boardId === memberBoardId)).toMatchObject({
      owned: true,
      hasPublicLink: false,
    });
    expect(mine.find((board) => board.boardId === boardId)).toMatchObject({
      title: 'Personal',
      owned: false,
      hasPublicLink: true,
    });

    const ownerBoards = await owner.query(api.boards.listMyBoards, {});
    expect(ownerBoards).toHaveLength(1);
    expect(ownerBoards[0]).toMatchObject({ boardId, owned: true, isDefault: true });
  });

  test('liveCardsForThread matches indexed and legacy provenance', async () => {
    const { t, owner } = makeHarness();
    const boardId = await owner.mutation(api.boards.ensureDefaultBoard, {});
    const [today] = await boardColumns(t, boardId);
    const cardId = await owner.mutation(api.boards.createCard, {
      boardId,
      columnId: today._id,
      title: 'From email',
      source: { threadId: 'th_indexed', accountId: 'acc_1' },
    });
    const ts = Date.now();
    await t.run((ctx) =>
      ctx.db.insert('cards', {
        boardId,
        columnId: today._id,
        userId: 'user_owner',
        title: 'Legacy provenance',
        order: 9999,
        source: { threadId: 'th_legacy' },
        createdAt: ts,
        updatedAt: ts,
      }),
    );

    await expect(t.query(api.boards.liveCardsForThread, { threadId: 'th_indexed' })).rejects.toThrow(
      'Not authenticated',
    );
    expect(await owner.query(api.boards.liveCardsForThread, { threadId: '' })).toEqual([]);
    const indexed = await owner.query(api.boards.liveCardsForThread, { threadId: 'th_indexed' });
    expect(indexed).toEqual([{ cardId, title: 'From email', completedAt: undefined }]);
    const legacy = await owner.query(api.boards.liveCardsForThread, { threadId: 'th_legacy' });
    expect(legacy.map((card) => card.title)).toEqual(['Legacy provenance']);
    expect(await owner.query(api.boards.liveCardsForThread, { threadId: 'th_missing' })).toEqual([]);
  });

  test('liveCardsForCalendarEvent matches event ids, master ids, and legacy sources', async () => {
    const { t, owner } = makeHarness();
    const boardId = await owner.mutation(api.boards.ensureDefaultBoard, {});
    const [today] = await boardColumns(t, boardId);
    const eventCard = await owner.mutation(api.boards.createCard, {
      boardId,
      columnId: today._id,
      title: 'Prep deck',
      source: { eventId: 'ev_1' },
    });
    const ts = Date.now();
    await t.run((ctx) =>
      ctx.db.insert('cards', {
        boardId,
        columnId: today._id,
        userId: 'user_owner',
        title: 'Legacy recurring prep',
        order: 8888,
        source: { providerEventId: 'ev_master' },
        createdAt: ts,
        updatedAt: ts,
      }),
    );

    await expect(t.query(api.boards.liveCardsForCalendarEvent, { eventId: 'ev_1' })).rejects.toThrow(
      'Not authenticated',
    );
    const indexed = await owner.query(api.boards.liveCardsForCalendarEvent, {
      eventId: 'ev_1',
      masterEventId: 'ev_master',
    });
    // Indexed matches win; the legacy card is only reachable via the fallback scan.
    expect(indexed).toEqual([{ cardId: eventCard, title: 'Prep deck', completedAt: undefined }]);
    const legacy = await owner.query(api.boards.liveCardsForCalendarEvent, { eventId: 'ev_master' });
    expect(legacy.map((card) => card.title)).toEqual(['Legacy recurring prep']);
    expect(await owner.query(api.boards.liveCardsForCalendarEvent, { eventId: 'ev_none' })).toEqual([]);
  });

  test('listDueCards windows by due date and listReportCards drops completed cards', async () => {
    const { t, owner } = makeHarness();
    const boardId = await owner.mutation(api.boards.ensureDefaultBoard, {});
    const [today] = await boardColumns(t, boardId);
    const base = Date.now();
    const doneCard = await owner.mutation(api.boards.createCard, {
      boardId,
      columnId: today._id,
      title: 'Already done',
      dueAt: base + 1_000,
    });
    await owner.mutation(api.boards.updateCard, { cardId: doneCard, completedAt: base });
    const dueSoon = await owner.mutation(api.boards.createCard, {
      boardId,
      columnId: today._id,
      title: 'Due soon',
      dueAt: base + 2_000,
    });
    const dueLater = await owner.mutation(api.boards.createCard, {
      boardId,
      columnId: today._id,
      title: 'Due later',
      dueAt: base + 5_000,
    });
    await owner.mutation(api.boards.createCard, {
      boardId,
      columnId: today._id,
      title: 'Out of window',
      dueAt: base + 100_000,
    });
    await owner.mutation(api.boards.createCard, { boardId, columnId: today._id, title: 'No due date' });

    const due = await owner.query(api.boards.listDueCards, { startAt: base, endAt: base + 10_000 });
    // The window is due-date based only; completion does not filter this lane.
    expect(due.map((card) => card.title).sort()).toEqual(['Already done', 'Due later', 'Due soon']);
    expect(due.find((card) => card.title === 'Due soon')?.cardId).toBe(dueSoon);

    const report = await owner.query(api.boards.listReportCards, { since: 0, endAt: base + 200_000 });
    expect(report.map((card) => card.title)).toEqual([
      'Due soon',
      'Due later',
      'Out of window',
      'No due date',
    ]);
    expect(report[0]).toMatchObject({ cardId: dueSoon, boardTitle: 'Personal', columnName: 'Today' });
    expect(report[1].cardId).toBe(dueLater);
    // The cap applies before the completion filter: a tiny limit that only
    // reaches the completed card yields nothing.
    const capped = await owner.query(api.boards.listReportCards, {
      since: 0,
      endAt: base + 200_000,
      limit: 1,
    });
    expect(capped).toEqual([]);
  });
});
