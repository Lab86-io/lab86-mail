import { z } from 'zod';
import { recordOperation, registerUndoExecutor } from '@/lib/ai/operations';
import {
  fetchEmailAttachment,
  fetchWebFile,
  getStagedAgentUpload,
  storeForCard,
} from '@/lib/attachments/fetch-store';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { requireConnectedAccount } from '@/lib/nylas/provider';
import { parseIsoInTimezone } from '@/lib/shared/timezones';
import { normalizeUrl } from '@/lib/shared/url';
import { defineTool } from './registry';

const boardsApi = (api as any).boards;
const calendarApi = (api as any).calendarData;

// AI control over the Kanban (spec M2). Every mutation records an inverse so
// "filed 10 tasks" is one reviewable, undoable change-set.

function requireUserId(userId: string | null | undefined): string {
  if (!userId) throw new Error('Not authenticated.');
  return userId;
}

async function getBoardForUser(userId: string, boardId: string) {
  return convexQuery<any>(boardsApi.getBoard, { userId, boardId });
}

async function resolveBoardAndColumn(
  userId: string,
  boardId: string | undefined,
  columnName: string | undefined,
) {
  let id = boardId;
  if (!id) {
    const boards = await convexQuery<any[]>(boardsApi.listMyBoards, { userId });
    const fallback = boards.find((board) => board.isDefault) || boards[0];
    id = fallback?.boardId;
    if (!id) {
      id = await convexMutation<string>(boardsApi.ensureDefaultBoard, { userId });
    }
  }
  const board = await getBoardForUser(userId, id as string);
  let column = board.columns[0];
  if (columnName) {
    const wanted = columnName.trim().toLowerCase();
    column = board.columns.find((c: any) => c.name.toLowerCase() === wanted);
    if (!column) {
      throw new Error(
        `No column named "${columnName}" on "${board.title}". Columns: ${board.columns
          .map((c: any) => c.name)
          .join(', ')}`,
      );
    }
  }
  if (!column) throw new Error(`Board "${board.title}" has no columns.`);
  return { board, column };
}

const prioritySchema = z.enum(['low', 'medium', 'high']);
const sourceSchema = z.object({
  kind: z.enum(['email', 'calendar', 'chat', 'suggestion', 'manual']),
  accountId: z.string().optional(),
  threadId: z.string().optional(),
  messageId: z.string().optional(),
  calendarId: z.string().optional(),
  eventId: z.string().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
});

export const tasksListBoards = defineTool({
  name: 'tasks_list_boards',
  description: 'List the user’s Kanban boards (owned and shared with them).',
  category: 'tasks',
  mutating: false,
  input: z.object({}),
  output: z.object({ boards: z.array(z.any()) }),
  async handler(_args, ctx) {
    const userId = requireUserId(ctx.userId);
    const boards = await convexQuery<any[]>(boardsApi.listMyBoards, { userId });
    return { boards };
  },
});

export const tasksGetBoard = defineTool({
  name: 'tasks_get_board',
  description:
    'Get a board with its columns and cards. Omit boardId for the default Personal board. Card ids are used by the update/move/delete tools.',
  category: 'tasks',
  mutating: false,
  input: z.object({ boardId: z.string().optional() }),
  output: z.object({ board: z.any() }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const { board } = await resolveBoardAndColumn(userId, args.boardId, undefined);
    return { board };
  },
});

export const tasksCreateBoard = defineTool({
  name: 'tasks_create_board',
  description: 'Create a new Kanban board, optionally with custom column names.',
  category: 'tasks',
  mutating: true,
  input: z.object({
    title: z.string().min(1),
    columns: z.array(z.string()).optional(),
  }),
  output: z.object({ ok: z.boolean(), boardId: z.string(), operationId: z.string() }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const boardId = await convexMutation<string>(boardsApi.createBoard, {
      userId,
      title: args.title,
      columns: args.columns,
    });
    const operationId = await recordOperation({
      userId,
      tool: 'tasks_create_board',
      surface: 'tasks',
      summary: `Created board "${args.title}"`,
      target: { kind: 'board', id: boardId },
      inverse: { kind: 'tasks.delete_board', payload: { boardId } },
    });
    return { ok: true, boardId, operationId };
  },
});

export const tasksCreateCard = defineTool({
  name: 'tasks_create_card',
  description:
    'Create a card on a board. Omit boardId for the default board; column defaults to the first column (use column:"Today" etc.). dueIso sets a due date (naive timestamps are the user’s timezone). assignees are board-member emails. Pass source when the task came from an email or calendar event so the card carries a provenance link.',
  category: 'tasks',
  mutating: true,
  input: z.object({
    boardId: z.string().optional(),
    column: z.string().optional(),
    title: z.string().min(1),
    description: z.string().optional(),
    labels: z.array(z.string()).optional(),
    priority: prioritySchema.optional(),
    weight: z.number().int().min(0).optional(),
    assignees: z.array(z.string().email()).optional(),
    dueIso: z.string().optional(),
    source: sourceSchema.optional(),
  }),
  output: z.object({ ok: z.boolean(), cardId: z.string(), operationId: z.string() }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const { board, column } = await resolveBoardAndColumn(userId, args.boardId, args.column);
    const cardId = await convexMutation<string>(boardsApi.createCard, {
      userId,
      boardId: board.boardId,
      columnId: column.columnId,
      title: args.title,
      description: args.description,
      labels: args.labels,
      priority: args.priority,
      weight: args.weight,
      assignees: args.assignees,
      dueAt: args.dueIso ? parseIsoInTimezone(args.dueIso, ctx.userTimezone, 'dueIso') : undefined,
      source: args.source ?? { kind: 'chat' },
    });
    const operationId = await recordOperation({
      userId,
      tool: 'tasks_create_card',
      surface: 'tasks',
      summary: `Added "${args.title}" to ${column.name} on "${board.title}"`,
      target: { kind: 'card', id: cardId, boardId: board.boardId },
      inverse: { kind: 'tasks.delete_card', payload: { cardId } },
    });
    return { ok: true, cardId, operationId };
  },
});

export const tasksUpdateCard = defineTool({
  name: 'tasks_update_card',
  description:
    'Update a card’s fields (title, description, labels, priority, due date, completed, source provenance). Pass dueIso:null to clear the due date. completed:true marks done.',
  category: 'tasks',
  mutating: true,
  input: z.object({
    cardId: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    labels: z.array(z.string()).optional(),
    priority: prioritySchema.optional(),
    weight: z.number().int().min(0).nullable().optional(),
    assignees: z.array(z.string().email()).optional(),
    dueIso: z.string().nullable().optional(),
    completed: z.boolean().optional(),
    source: sourceSchema.optional(),
  }),
  output: z.object({ ok: z.boolean(), operationId: z.string() }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const result = await convexMutation<{ previous: any }>(boardsApi.updateCard, {
      userId,
      cardId: args.cardId,
      title: args.title,
      description: args.description,
      labels: args.labels,
      priority: args.priority,
      weight: args.weight,
      assignees: args.assignees,
      dueAt:
        args.dueIso === undefined
          ? undefined
          : args.dueIso === null
            ? null
            : parseIsoInTimezone(args.dueIso, ctx.userTimezone, 'dueIso'),
      completedAt: args.completed === undefined ? undefined : args.completed ? Date.now() : null,
      source: args.source,
    });
    const operationId = await recordOperation({
      userId,
      tool: 'tasks_update_card',
      surface: 'tasks',
      summary: `Updated "${result.previous.title}"`,
      target: { kind: 'card', id: args.cardId, boardId: result.previous.boardId },
      inverse: {
        kind: 'tasks.restore_card',
        payload: { cardId: args.cardId, fields: result.previous },
      },
    });
    return { ok: true, operationId };
  },
});

export const tasksMoveCard = defineTool({
  name: 'tasks_move_card',
  description: 'Move a card to another column on its board (by column name), appended at the end.',
  category: 'tasks',
  mutating: true,
  input: z.object({
    cardId: z.string(),
    boardId: z.string().optional(),
    column: z.string().min(1),
  }),
  output: z.object({ ok: z.boolean(), operationId: z.string() }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const { board, column } = await resolveBoardAndColumn(userId, args.boardId, args.column);
    const result = await convexMutation<{ previous: { columnId: string; order: number } }>(
      boardsApi.moveCard,
      { userId, cardId: args.cardId, columnId: column.columnId },
    );
    const operationId = await recordOperation({
      userId,
      tool: 'tasks_move_card',
      surface: 'tasks',
      summary: `Moved a card to ${column.name} on "${board.title}"`,
      target: { kind: 'card', id: args.cardId, boardId: board.boardId },
      inverse: {
        kind: 'tasks.move_card',
        payload: { cardId: args.cardId, ...result.previous },
      },
    });
    return { ok: true, operationId };
  },
});

export const tasksDeleteCard = defineTool({
  name: 'tasks_delete_card',
  description: 'Delete a card. Undoable — undo recreates it with the same content.',
  category: 'tasks',
  mutating: true,
  input: z.object({ cardId: z.string() }),
  output: z.object({ ok: z.boolean(), operationId: z.string() }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const result = await convexMutation<{ previous: any }>(boardsApi.deleteCard, {
      userId,
      cardId: args.cardId,
    });
    const operationId = await recordOperation({
      userId,
      tool: 'tasks_delete_card',
      surface: 'tasks',
      summary: `Deleted "${result.previous.title}"`,
      target: { kind: 'card', id: args.cardId, boardId: result.previous.boardId },
      inverse: { kind: 'tasks.recreate_card', payload: { fields: result.previous } },
    });
    return { ok: true, operationId };
  },
});

export const tasksCreateColumn = defineTool({
  name: 'tasks_create_column',
  description: 'Add a column to a board (omit boardId for the default board).',
  category: 'tasks',
  mutating: true,
  input: z.object({ boardId: z.string().optional(), name: z.string().min(1) }),
  output: z.object({ ok: z.boolean(), columnId: z.string(), operationId: z.string() }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const { board } = await resolveBoardAndColumn(userId, args.boardId, undefined);
    const columnId = await convexMutation<string>(boardsApi.createColumn, {
      userId,
      boardId: board.boardId,
      name: args.name,
    });
    const operationId = await recordOperation({
      userId,
      tool: 'tasks_create_column',
      surface: 'tasks',
      summary: `Added column "${args.name}" to "${board.title}"`,
      target: { kind: 'column', id: columnId, boardId: board.boardId },
      inverse: { kind: 'tasks.delete_column', payload: { columnId } },
    });
    return { ok: true, columnId, operationId };
  },
});

export const tasksRenameColumn = defineTool({
  name: 'tasks_rename_column',
  description: 'Rename a column (find it by current name; omit boardId for the default board).',
  category: 'tasks',
  mutating: true,
  input: z.object({ boardId: z.string().optional(), column: z.string().min(1), name: z.string().min(1) }),
  output: z.object({ ok: z.boolean(), operationId: z.string() }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const { board, column } = await resolveBoardAndColumn(userId, args.boardId, args.column);
    await convexMutation(boardsApi.updateColumn, { userId, columnId: column.columnId, name: args.name });
    const operationId = await recordOperation({
      userId,
      tool: 'tasks_rename_column',
      surface: 'tasks',
      summary: `Renamed column "${column.name}" to "${args.name}" on "${board.title}"`,
      target: { kind: 'column', id: column.columnId, boardId: board.boardId },
      inverse: {
        kind: 'tasks.rename_column',
        payload: { columnId: column.columnId, name: column.name },
      },
    });
    return { ok: true, operationId };
  },
});

export const tasksDeleteColumn = defineTool({
  name: 'tasks_delete_column',
  description:
    'Delete a column AND its cards (find it by name; omit boardId for the default board). Not undoable — confirm with the user when cards would be lost.',
  category: 'tasks',
  mutating: true,
  input: z.object({ boardId: z.string().optional(), column: z.string().min(1) }),
  output: z.object({ ok: z.boolean(), operationId: z.string() }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const { board, column } = await resolveBoardAndColumn(userId, args.boardId, args.column);
    await convexMutation(boardsApi.deleteColumn, { userId, columnId: column.columnId });
    const operationId = await recordOperation({
      userId,
      tool: 'tasks_delete_column',
      surface: 'tasks',
      summary: `Deleted column "${column.name}" from "${board.title}"`,
      target: { kind: 'column', id: column.columnId, boardId: board.boardId },
    });
    return { ok: true, operationId };
  },
});

export const tasksRenameBoard = defineTool({
  name: 'tasks_rename_board',
  description: 'Rename a board.',
  category: 'tasks',
  mutating: true,
  input: z.object({ boardId: z.string(), title: z.string().min(1) }),
  output: z.object({ ok: z.boolean(), operationId: z.string() }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const board = await getBoardForUser(userId, args.boardId);
    await convexMutation(boardsApi.renameBoard, { userId, boardId: args.boardId, title: args.title });
    const operationId = await recordOperation({
      userId,
      tool: 'tasks_rename_board',
      surface: 'tasks',
      summary: `Renamed board "${board.title}" to "${args.title}"`,
      target: { kind: 'board', id: args.boardId },
      inverse: { kind: 'tasks.rename_board', payload: { boardId: args.boardId, title: board.title } },
    });
    return { ok: true, operationId };
  },
});

export const tasksDeleteBoard = defineTool({
  name: 'tasks_delete_board',
  description:
    'Delete a whole board with its columns and cards. Not undoable — always confirm with the user first.',
  category: 'tasks',
  mutating: true,
  input: z.object({ boardId: z.string() }),
  output: z.object({ ok: z.boolean(), operationId: z.string() }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const board = await getBoardForUser(userId, args.boardId);
    await convexMutation(boardsApi.deleteBoard, { userId, boardId: args.boardId });
    const operationId = await recordOperation({
      userId,
      tool: 'tasks_delete_board',
      surface: 'tasks',
      summary: `Deleted board "${board.title}"`,
      target: { kind: 'board', id: args.boardId },
    });
    return { ok: true, operationId };
  },
});

export const tasksAddComment = defineTool({
  name: 'tasks_add_comment',
  description: 'Add a comment to a card on the user’s behalf.',
  category: 'tasks',
  mutating: true,
  input: z.object({ cardId: z.string(), body: z.string().min(1) }),
  output: z.object({ ok: z.boolean() }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    await convexMutation(boardsApi.addComment, { userId, cardId: args.cardId, body: args.body });
    return { ok: true };
  },
});

export const tasksAttachLink = defineTool({
  name: 'tasks_attach_link',
  description:
    'Attach a link to a card. The url is forgiving — "example.com" or "https://example.com" both work.',
  category: 'tasks',
  mutating: true,
  input: z.object({ cardId: z.string(), name: z.string().optional(), url: z.string().min(1) }),
  output: z.object({ ok: z.boolean(), url: z.string(), operationId: z.string() }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const url = normalizeUrl(args.url);
    if (!url) throw new Error(`Not a usable URL: ${args.url}`);
    const result = await convexMutation<{ previous: any }>(boardsApi.attachToCard, {
      userId,
      cardId: args.cardId,
      name: args.name?.trim() || url,
      url,
    });
    const operationId = await recordOperation({
      userId,
      tool: 'tasks_attach_link',
      surface: 'tasks',
      summary: `Attached link to "${result.previous.title}"`,
      target: { kind: 'card', id: args.cardId, boardId: result.previous.boardId },
      inverse: { kind: 'tasks.restore_card', payload: { cardId: args.cardId, fields: result.previous } },
    });
    return { ok: true, url, operationId };
  },
});

export const tasksAttachFile = defineTool({
  name: 'tasks_attach_file',
  description:
    'Attach a file to a card as an uploaded file (not just a link). Provide a chatUploadId from the current assistant turn, OR a web url, OR an email attachment (account + messageId + attachmentId). Use this when the user says "save/attach this file to the card".',
  category: 'tasks',
  mutating: true,
  input: z.object({
    cardId: z.string(),
    name: z.string().optional(),
    chatUploadId: z.string().optional(),
    url: z.string().optional(),
    account: z.string().optional(),
    messageId: z.string().optional(),
    attachmentId: z.string().optional(),
  }),
  output: z.object({ ok: z.boolean(), name: z.string(), operationId: z.string() }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const sources = [args.chatUploadId, args.url, args.account && args.messageId && args.attachmentId].filter(
      Boolean,
    );
    if (sources.length !== 1) {
      throw new Error(
        'Provide exactly one file source: chatUploadId, url, or account + messageId + attachmentId.',
      );
    }
    if (args.chatUploadId) {
      const staged = await getStagedAgentUpload(userId, args.chatUploadId);
      if (!staged) throw new Error('Chat upload not found or not owned by this user.');
      const name = args.name?.trim() || staged.name;
      const result = await convexMutation<{ previous: any }>(boardsApi.attachToCard, {
        userId,
        cardId: args.cardId,
        name,
        storageId: staged.storageId,
        contentType: staged.contentType,
        size: staged.size,
      });
      const operationId = await recordOperation({
        userId,
        tool: 'tasks_attach_file',
        surface: 'tasks',
        summary: `Attached "${name}" to "${result.previous.title}"`,
        target: { kind: 'card', id: args.cardId, boardId: result.previous.boardId },
        inverse: { kind: 'tasks.restore_card', payload: { cardId: args.cardId, fields: result.previous } },
      });
      return { ok: true, name, operationId };
    }
    // The source validation above guarantees exactly one source and the
    // chatUploadId case returned already, so here it is url or email attachment.
    const blob = args.url
      ? await fetchWebFile(args.url, args.name)
      : await fetchEmailAttachment(userId, args.account!, args.attachmentId!, args.messageId!, args.name);
    const stored = await storeForCard(userId, args.cardId, blob);
    const result = await convexMutation<{ previous: any }>(boardsApi.attachToCard, {
      userId,
      cardId: args.cardId,
      name: args.name?.trim() || stored.name,
      storageId: stored.storageId,
      contentType: stored.contentType,
      size: stored.size,
    });
    const operationId = await recordOperation({
      userId,
      tool: 'tasks_attach_file',
      surface: 'tasks',
      summary: `Attached "${stored.name}" to "${result.previous.title}"`,
      target: { kind: 'card', id: args.cardId, boardId: result.previous.boardId },
      inverse: { kind: 'tasks.restore_card', payload: { cardId: args.cardId, fields: result.previous } },
    });
    return { ok: true, name: stored.name, operationId };
  },
});

export const tasksAttachCalendarEventLink = defineTool({
  name: 'tasks_attach_calendar_event_link',
  description:
    'Attach a provider link for a calendar event to a task card and, by default, set that event as the card provenance source. Use this when the user wants a task to reference a calendar event and you have the eventId/account, or after calendar_list_events finds the event.',
  category: 'tasks',
  mutating: true,
  input: z.object({
    cardId: z.string(),
    account: z.string(),
    eventId: z.string(),
    name: z.string().optional(),
    setAsSource: z.boolean().default(true),
  }),
  output: z.object({ ok: z.boolean(), url: z.string(), name: z.string(), operationId: z.string() }),
  async handler(args, ctx) {
    const userId = requireUserId(ctx.userId);
    const account = await requireConnectedAccount(userId, args.account);
    const event = await convexQuery<any | null>(calendarApi.getEventByProviderId, {
      userId,
      accountId: account.accountId,
      providerEventId: args.eventId,
    });
    if (!event) throw new Error('Calendar event not found. Run calendar_list_events to find the eventId.');
    const url = event.htmlLink;
    if (!url) {
      throw new Error('This synced calendar event does not expose a provider link.');
    }
    const name = args.name?.trim() || event.title || 'Calendar event';
    const result = await convexMutation<{ previous: any }>(boardsApi.attachToCard, {
      userId,
      cardId: args.cardId,
      name,
      url,
    });
    // Record the undo operation right after the attach succeeds so a later
    // setAsSource failure still leaves the attachment revertible.
    const operationId = await recordOperation({
      userId,
      tool: 'tasks_attach_calendar_event_link',
      surface: 'tasks',
      summary: `Attached calendar event "${name}" to "${result.previous.title}"`,
      target: { kind: 'card', id: args.cardId, boardId: result.previous.boardId },
      inverse: { kind: 'tasks.restore_card', payload: { cardId: args.cardId, fields: result.previous } },
    });
    if (args.setAsSource) {
      await convexMutation(boardsApi.updateCard, {
        userId,
        cardId: args.cardId,
        source: {
          kind: 'calendar',
          accountId: event.accountId,
          calendarId: event.providerCalendarId,
          eventId: event.providerEventId,
          url,
          title: event.title,
        },
      });
    }
    return { ok: true, url, name, operationId };
  },
});

// ---- undo executors ---------------------------------------------------------

registerUndoExecutor('tasks.delete_card', async (payload, ctx) => {
  await convexMutation(boardsApi.deleteCard, { userId: ctx.userId, cardId: payload.cardId });
});

registerUndoExecutor('tasks.recreate_card', async (payload, ctx) => {
  const fields = payload.fields || {};
  await convexMutation(boardsApi.createCard, {
    userId: ctx.userId,
    boardId: fields.boardId,
    columnId: fields.columnId,
    title: fields.title,
    description: fields.description,
    labels: fields.labels,
    priority: fields.priority,
    assignees: fields.assignees,
    dueAt: fields.dueAt,
    source: fields.source,
  });
});

registerUndoExecutor('tasks.restore_card', async (payload, ctx) => {
  const fields = payload.fields || {};
  await convexMutation(boardsApi.updateCard, {
    userId: ctx.userId,
    cardId: payload.cardId,
    title: fields.title,
    description: fields.description ?? '',
    labels: fields.labels ?? [],
    priority: fields.priority,
    assignees: fields.assignees ?? [],
    dueAt: fields.dueAt ?? null,
    completedAt: fields.completedAt ?? null,
    attachments: fields.attachments ?? [],
    source: fields.source,
  });
});

registerUndoExecutor('tasks.move_card', async (payload, ctx) => {
  await convexMutation(boardsApi.moveCard, {
    userId: ctx.userId,
    cardId: payload.cardId,
    columnId: payload.columnId,
    beforeOrder: payload.order - 1,
    afterOrder: payload.order + 1,
  });
});

registerUndoExecutor('tasks.delete_board', async (payload, ctx) => {
  await convexMutation(boardsApi.deleteBoard, { userId: ctx.userId, boardId: payload.boardId });
});

registerUndoExecutor('tasks.delete_column', async (payload, ctx) => {
  await convexMutation(boardsApi.deleteColumn, { userId: ctx.userId, columnId: payload.columnId });
});

registerUndoExecutor('tasks.rename_column', async (payload, ctx) => {
  await convexMutation(boardsApi.updateColumn, {
    userId: ctx.userId,
    columnId: payload.columnId,
    name: payload.name,
  });
});

registerUndoExecutor('tasks.rename_board', async (payload, ctx) => {
  await convexMutation(boardsApi.renameBoard, {
    userId: ctx.userId,
    boardId: payload.boardId,
    title: payload.title,
  });
});
