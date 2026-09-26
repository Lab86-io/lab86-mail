import { z } from 'zod';
import {
  changedFolders,
  formatWakeTime,
  MAIL_UNDO,
  type MessageFolderChange,
  mailOperationReason,
  mapLimit,
  pluralThreads,
  quotedSubject,
  recordMailOperation,
  type ThreadFolderChange,
  threadSubject,
} from '../mail/mail-operations';
import {
  createNylasFolder,
  moveNylasThread,
  updateNylasMessage,
  updateNylasMessageFolders,
  updateNylasMessageFoldersWithRetry,
  updateNylasThread,
  updateNylasThreadFolders,
  updateNylasThreadFoldersWithRetry,
} from '../nylas/provider';
import { snoozeThread, unsnoozeThread } from '../store/snooze';
import { getThread, setThreadGmailLabelSync, setThreadReadState, upsertThread } from '../store/threads';
import { defineTool, type ToolContext } from './registry';

const BasicMutate = z.object({
  account: z.string(),
  messageId: z.string(),
});

const ThreadMutate = z.object({
  account: z.string(),
  threadId: z.string(),
});

// Why the change happened, in one short sentence. Activity shows it under the
// summary, so the user can see why Albatross moved their mail.
const Reason = z
  .string()
  .max(300)
  .optional()
  .describe('One short sentence on why you are doing this. Shown to the user in Activity.');

// Every mail change reports its operation, so a toast (web) or a command
// receipt (native) can offer Undo right away.
const MutateOutput = z.object({ ok: z.boolean(), operationId: z.string().optional() });

type ThreadMove = 'archive' | 'trash' | 'inbox';

function moveSummary(to: ThreadMove, subject: string | null, count = 1) {
  if (count > 1) {
    const threads = pluralThreads(count);
    return to === 'archive'
      ? `Archived ${threads}`
      : to === 'trash'
        ? `Moved ${threads} to Trash`
        : `Moved ${threads} back to the inbox`;
  }
  const quoted = quotedSubject(subject);
  return to === 'archive'
    ? `Archived ${quoted}`
    : to === 'trash'
      ? `Moved ${quoted} to Trash`
      : `Moved ${quoted} back to the inbox`;
}

/** Records one undoable operation for thread moves that changed something. */
export async function recordThreadMoves(
  ctx: Pick<ToolContext, 'userId' | 'agent' | 'operationBatchId'>,
  input: { tool: string; to: ThreadMove; changes: ThreadFolderChange[]; reason?: string },
) {
  const changes = input.changes.filter(changedFolders);
  if (!changes.length) return undefined;
  const single = changes.length === 1 ? changes[0] : null;
  const subject = single ? await threadSubject(single.account, single.threadId) : null;
  return recordMailOperation({
    userId: ctx.userId,
    tool: input.tool,
    summary: moveSummary(input.to, subject, changes.length),
    reason: mailOperationReason(ctx, input.reason),
    target: single
      ? { kind: 'thread', id: single.threadId, accountId: single.account }
      : {
          kind: 'threads',
          count: changes.length,
          ids: changes.slice(0, 50).map((change) => `${change.account}:${change.threadId}`),
        },
    inverse: { kind: MAIL_UNDO.threadFolders, payload: { threads: changes } },
    batchId: ctx.operationBatchId,
  });
}

async function moveOneThread(
  ctx: ToolContext,
  tool: string,
  input: { account: string; threadId: string; reason?: string },
  to: ThreadMove,
) {
  const change = await requireNylasResult(
    moveNylasThread({ userId: ctx.userId, account: input.account, threadId: input.threadId, to }),
  );
  const operationId = await recordThreadMoves(ctx, {
    tool,
    to,
    reason: input.reason,
    changes: [
      { account: input.account, threadId: input.threadId, before: change.before, after: change.after },
    ],
  });
  return { ok: true, operationId };
}

export const archiveThread = defineTool({
  name: 'archive_thread',
  description: 'Archive a thread. The change shows in Activity with Undo.',
  category: 'mail',
  mutating: true,
  input: ThreadMutate.extend({ reason: Reason }),
  output: MutateOutput,
  async handler(args, ctx) {
    return await moveOneThread(ctx, 'archive_thread', args, 'archive');
  },
});

export const trashThread = defineTool({
  name: 'trash_thread',
  description: 'Move a thread to Trash. The change shows in Activity with Undo.',
  category: 'mail',
  mutating: true,
  input: ThreadMutate.extend({ reason: Reason }),
  output: MutateOutput,
  async handler(args, ctx) {
    return await moveOneThread(ctx, 'trash_thread', args, 'trash');
  },
});

export const restoreFromTrash = defineTool({
  name: 'restore_from_trash',
  description: 'Restore a thread from Trash or Archive to the inbox. The change shows in Activity with Undo.',
  category: 'mail',
  mutating: true,
  input: ThreadMutate.extend({ reason: Reason }),
  output: MutateOutput,
  async handler(args, ctx) {
    return await moveOneThread(ctx, 'restore_from_trash', args, 'inbox');
  },
});

/** The most threads one bulk move takes. */
export const BULK_MOVE_LIMIT = 100;

export const bulkMoveThreads = defineTool({
  name: 'bulk_move_threads',
  description:
    'Archive, trash, or restore many threads at once. Records one Activity entry with Undo for the whole selection.',
  category: 'mail',
  mutating: true,
  input: z.object({
    items: z
      .array(z.object({ account: z.string(), threadId: z.string() }))
      .min(1)
      .max(BULK_MOVE_LIMIT),
    to: z.enum(['archive', 'trash', 'inbox']),
    reason: Reason,
  }),
  output: z.object({
    ok: z.boolean(),
    moved: z.array(z.object({ account: z.string(), threadId: z.string() })),
    failed: z.array(z.object({ account: z.string(), threadId: z.string(), error: z.string() })),
    operationId: z.string().optional(),
  }),
  async handler({ items, to, reason }, ctx) {
    const unique = [...new Map(items.map((item) => [`${item.account}:${item.threadId}`, item])).values()];
    const results = await mapLimit(unique, 4, async (item) =>
      requireNylasResult(
        moveNylasThread({ userId: ctx.userId, account: item.account, threadId: item.threadId, to }),
      ),
    );
    const moved: Array<{ account: string; threadId: string }> = [];
    const failed: Array<{ account: string; threadId: string; error: string }> = [];
    const changes: ThreadFolderChange[] = [];
    results.forEach((result, index) => {
      const item = unique[index];
      if (result.status === 'fulfilled') {
        moved.push(item);
        changes.push({ ...item, before: result.value.before, after: result.value.after });
      } else {
        const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
        failed.push({ ...item, error: error.slice(0, 300) });
      }
    });
    const operationId = await recordThreadMoves(ctx, { tool: 'bulk_move_threads', to, changes, reason });
    return { ok: failed.length === 0, moved, failed, operationId };
  },
});

export const markRead = defineTool({
  name: 'mark_read',
  description: 'Mark a message as read.',
  category: 'mail',
  mutating: true,
  input: BasicMutate,
  output: z.object({ ok: z.boolean() }),
  async handler({ account, messageId }, ctx) {
    return await requireNylasResult(
      updateNylasMessage({
        userId: ctx.userId,
        account,
        messageId,
        unread: false,
      }),
    );
  },
});

export const markUnread = defineTool({
  name: 'mark_unread',
  description: 'Mark a message as unread.',
  category: 'mail',
  mutating: true,
  input: BasicMutate,
  output: z.object({ ok: z.boolean() }),
  async handler({ account, messageId }, ctx) {
    return await requireNylasResult(
      updateNylasMessage({
        userId: ctx.userId,
        account,
        messageId,
        unread: true,
      }),
    );
  },
});

export const markThreadRead = defineTool({
  name: 'mark_thread_read',
  description: 'Mark every unread message in a thread as read and update the cached thread state.',
  category: 'mail',
  mutating: true,
  input: z.object({
    account: z.string(),
    threadId: z.string(),
    messageIds: z.array(z.string()).optional(),
  }),
  output: z.object({ ok: z.boolean(), marked: z.number() }),
  async handler({ account, threadId, messageIds }, ctx) {
    await requireNylasResult(
      updateNylasThread({
        userId: ctx.userId,
        account,
        threadId,
        unread: false,
      }),
    );
    const existing = await getThread(account, threadId).catch(() => null);
    await upsertThread(account, {
      _id: threadId,
      unread: false,
      labels: (existing?.labels || []).filter((label) => label !== 'UNREAD'),
      readState: { ...(existing?.readState || {}), openedAt: Date.now(), lastMarkedReadAt: Date.now() },
    }).catch(() => undefined);
    await setThreadReadState(account, threadId, {
      ...(existing?.readState || {}),
      openedAt: Date.now(),
      lastMarkedReadAt: Date.now(),
    }).catch(() => undefined);
    return { ok: true, marked: messageIds?.length || 0 };
  },
});

export const starMessage = defineTool({
  name: 'star',
  description: 'Star a message.',
  category: 'mail',
  mutating: true,
  input: BasicMutate,
  output: z.object({ ok: z.boolean() }),
  async handler({ account, messageId }, ctx) {
    return await requireNylasResult(
      updateNylasMessage({
        userId: ctx.userId,
        account,
        messageId,
        starred: true,
      }),
    );
  },
});

export const unstarMessage = defineTool({
  name: 'unstar',
  description: 'Remove the starred state from a message.',
  category: 'mail',
  mutating: true,
  input: BasicMutate,
  output: z.object({ ok: z.boolean() }),
  async handler({ account, messageId }, ctx) {
    return await requireNylasResult(
      updateNylasMessage({
        userId: ctx.userId,
        account,
        messageId,
        starred: false,
      }),
    );
  },
});

async function recordMessageLabelChange(
  ctx: ToolContext,
  input: { tool: string; label: string; adding: boolean; change: MessageFolderChange; reason?: string },
) {
  if (!changedFolders(input.change)) return undefined;
  const label = input.label.trim().slice(0, 80);
  return recordMailOperation({
    userId: ctx.userId,
    tool: input.tool,
    summary: input.adding ? `Added the label "${label}" to a message` : `Removed the label "${label}"`,
    reason: mailOperationReason(ctx, input.reason),
    target: { kind: 'message', id: input.change.messageId, accountId: input.change.account },
    inverse: { kind: MAIL_UNDO.messageFolders, payload: input.change },
    batchId: ctx.operationBatchId,
  });
}

export const addLabel = defineTool({
  name: 'add_label',
  description: 'Add a folder/label to a message. The change shows in Activity with Undo.',
  category: 'mail',
  mutating: true,
  input: BasicMutate.extend({ label: z.string(), reason: Reason }),
  output: MutateOutput,
  async handler({ account, messageId, label, reason }, ctx) {
    const change = await requireNylasResult(
      updateNylasMessageFolders({
        userId: ctx.userId,
        account,
        messageId,
        add: [label],
        createMissing: true,
      }),
    );
    const operationId = await recordMessageLabelChange(ctx, {
      tool: 'add_label',
      label,
      adding: true,
      reason,
      change: { account, messageId, before: change.before, after: change.after },
    });
    return { ok: true, operationId };
  },
});

export const removeLabel = defineTool({
  name: 'remove_label',
  description: 'Remove a folder/label from a message. The change shows in Activity with Undo.',
  category: 'mail',
  mutating: true,
  input: BasicMutate.extend({ label: z.string(), reason: Reason }),
  output: MutateOutput,
  async handler({ account, messageId, label, reason }, ctx) {
    const change = await requireNylasResult(
      updateNylasMessageFolders({
        userId: ctx.userId,
        account,
        messageId,
        remove: [label],
      }),
    );
    const operationId = await recordMessageLabelChange(ctx, {
      tool: 'remove_label',
      label,
      adding: false,
      reason,
      change: { account, messageId, before: change.before, after: change.after },
    });
    return { ok: true, operationId };
  },
});

export const createLabel = defineTool({
  name: 'create_label',
  description: 'Create a new provider folder/label.',
  category: 'mail',
  mutating: true,
  input: z.object({ account: z.string(), name: z.string() }),
  output: z.object({ ok: z.boolean(), id: z.string().optional() }),
  async handler({ account, name }, ctx) {
    const created = await requireNylasResult(
      createNylasFolder({
        userId: ctx.userId,
        account,
        name,
      }),
    );
    return { ok: true, id: created.id };
  },
});

export const applySmartLabels = defineTool({
  name: 'apply_smart_labels',
  description: 'Create missing MailOS labels and apply reviewed smart labels to messages or threads.',
  category: 'mail',
  mutating: true,
  input: z.object({
    account: z.string(),
    items: z
      .array(
        z.object({
          threadId: z.string(),
          messageId: z.string().optional(),
          labels: z.array(z.string()).min(1),
        }),
      )
      .min(1)
      .max(80),
  }),
  output: z.object({ ok: z.boolean(), applied: z.number(), operationId: z.string().optional() }),
  async handler({ account, items }, ctx) {
    const threadChanges: ThreadFolderChange[] = [];
    const messageChanges: MessageFolderChange[] = [];
    const uniqueLabels = [
      ...new Set(items.flatMap((item) => item.labels).filter((label) => label.startsWith('MailOS/'))),
    ];
    for (const label of uniqueLabels) {
      await requireNylasResult(createNylasFolder({ userId: ctx.userId, account, name: label }));
      await delay(250);
    }

    let applied = 0;
    for (const item of items) {
      const labels = [...new Set(item.labels)];
      if (item.messageId) {
        const change = await requireNylasResult(
          updateNylasMessageFoldersWithRetry({
            userId: ctx.userId,
            account,
            messageId: item.messageId,
            add: labels,
            createMissing: true,
            retries: 5,
          }),
        );
        messageChanges.push({
          account,
          messageId: item.messageId,
          before: change.before,
          after: change.after,
        });
      } else {
        const change = await requireNylasResult(
          updateNylasThreadFoldersWithRetry({
            userId: ctx.userId,
            account,
            threadId: item.threadId,
            add: labels,
            createMissing: true,
            retries: 5,
          }),
        );
        threadChanges.push({ account, threadId: item.threadId, before: change.before, after: change.after });
      }
      applied += labels.length;

      const existing = await getThread(account, item.threadId).catch(() => null);
      const labelsApplied = [...new Set([...(existing?.gmailLabelSync?.labelsApplied || []), ...labels])];
      await setThreadGmailLabelSync(account, item.threadId, {
        labelsApplied,
        pendingLabels: [],
        lastAppliedAt: Date.now(),
      }).catch(() => undefined);
      await delay(500);
    }
    const threads = threadChanges.filter(changedFolders);
    const messages = messageChanges.filter(changedFolders);
    const touched = threads.length + messages.length;
    const operationId = touched
      ? await recordMailOperation({
          userId: ctx.userId,
          tool: 'apply_smart_labels',
          summary: `Applied labels to ${touched === 1 ? 'one thread' : pluralThreads(touched)}`,
          reason: mailOperationReason(ctx, `Labels: ${uniqueLabels.join(', ') || 'smart labels'}`),
          target: { kind: 'threads', count: touched, accountId: account },
          inverse: { kind: MAIL_UNDO.threadFolders, payload: { threads, messages } },
          batchId: ctx.operationBatchId,
        })
      : undefined;
    return { ok: true, applied, operationId };
  },
});

export const muteThread = defineTool({
  name: 'mute_thread',
  description: 'Mute a thread so future replies bypass the inbox. The change shows in Activity with Undo.',
  category: 'mail',
  mutating: true,
  input: ThreadMutate.extend({ reason: Reason }),
  output: MutateOutput,
  async handler({ account, threadId, reason }, ctx) {
    const change = await requireNylasResult(
      updateNylasThreadFolders({
        userId: ctx.userId,
        account,
        threadId,
        add: ['MUTE'],
      }),
    );
    const threadChange = { account, threadId, before: change.before, after: change.after };
    const operationId = changedFolders(threadChange)
      ? await recordMailOperation({
          userId: ctx.userId,
          tool: 'mute_thread',
          summary: `Muted ${quotedSubject(await threadSubject(account, threadId))}`,
          reason: mailOperationReason(ctx, reason),
          target: { kind: 'thread', id: threadId, accountId: account },
          inverse: { kind: MAIL_UNDO.threadFolders, payload: { threads: [threadChange] } },
          batchId: ctx.operationBatchId,
        })
      : undefined;
    return { ok: true, operationId };
  },
});

export const snoozeThreadTool = defineTool({
  name: 'snooze_thread',
  description:
    'Snooze a thread until a future time. The thread leaves the inbox now and comes back, unread, when the time passes.',
  category: 'mail',
  mutating: true,
  input: z.object({
    account: z.string(),
    messageId: z.string().optional(),
    threadId: z.string(),
    untilTs: z.number().describe('Epoch ms when the thread should come back'),
    reason: Reason,
  }),
  output: z.object({ ok: z.boolean(), untilIso: z.string(), operationId: z.string().optional() }),
  async handler({ account, messageId, threadId, untilTs, reason }, ctx) {
    if (!ctx.userId) throw new Error('Sign in required to snooze mail.');
    await snoozeThread({ userId: ctx.userId, account, threadId, messageId, untilTs });
    const operationId = await recordMailOperation({
      userId: ctx.userId,
      tool: 'snooze_thread',
      summary: `Snoozed ${quotedSubject(await threadSubject(account, threadId))} until ${formatWakeTime(
        untilTs,
        ctx.userTimezone,
      )}`,
      reason: mailOperationReason(ctx, reason),
      target: { kind: 'thread', id: threadId, accountId: account },
      inverse: { kind: MAIL_UNDO.unsnooze, payload: { account, threadId } },
      batchId: ctx.operationBatchId,
    });
    return { ok: true, untilIso: new Date(untilTs).toISOString(), operationId };
  },
});

export const unsnoozeThreadTool = defineTool({
  name: 'unsnooze_thread',
  description: 'Cancel a snooze and move the thread back to the inbox now.',
  category: 'mail',
  mutating: true,
  input: z.object({
    account: z.string(),
    threadId: z.string().optional(),
    messageId: z.string().optional(),
  }),
  output: z.object({ ok: z.boolean(), restored: z.number() }),
  async handler({ account, threadId, messageId }, ctx) {
    if (!ctx.userId) throw new Error('Sign in required to unsnooze mail.');
    const { restored } = await unsnoozeThread({ userId: ctx.userId, account, threadId, messageId });
    return { ok: true, restored };
  },
});

async function requireNylasResult<T>(value: Promise<T | null>): Promise<T> {
  const result = await value;
  if (!result) throw new Error('Connected Nylas account not found.');
  return result;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
