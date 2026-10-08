// A Work thread's chat reply runs on the server to its end, also when the
// user leaves the thread (docs/albatross-threads.md, T5). The server saves the
// finished messages and tells the thread list: "Answering" while the reply
// runs, then the reply time, whether it waits for the user, and a preview.

import type { UIMessage } from 'ai';
import { endReply, startReply, stopReply } from '../ai/background-replies';
import { runWithAiRequestContext } from '../ai/context';
import { api, convexMutation } from '../hosted/convex';
import { truncateText } from '../shared/text';
import { saveChatSession } from '../store/chat-sessions';
import { isWorkThreadSessionId, workThreadSessionId } from './thread-contract';

/** The Work of a thread reply, or null when this request is not one. */
export function threadReplyWorkId(sessionId: unknown, contextWorkIds: readonly string[]): string | null {
  if (typeof sessionId !== 'string' || !isWorkThreadSessionId(sessionId)) return null;
  const workId = sessionId.slice('work-'.length);
  // The session must belong to the one Work in the context: no reply saves into another thread.
  return contextWorkIds.length === 1 && contextWorkIds[0] === workId ? workId : null;
}

function toolName(part: any): string {
  if (part?.type === 'dynamic-tool') return String(part.toolName || '');
  const type = String(part?.type || '');
  return type.startsWith('tool-') ? type.slice(5) : '';
}

/** True when the reply ends with a question that waits for the user (a form, a choice). */
export function replyWaitsForUser(message: UIMessage | null | undefined): boolean {
  return (message?.parts || []).some(
    (part: any) => toolName(part).startsWith('ask_') && part.state === 'input-available',
  );
}

/** The last words of the reply, for the list preview. */
export function replyPreviewText(message: UIMessage | null | undefined): string {
  const texts = (message?.parts || [])
    .filter((part: any) => part?.type === 'text' && typeof part.text === 'string' && part.text.trim())
    .map((part: any) => String(part.text));
  const last = texts.at(-1) || '';
  return truncateText(last.replace(/\s+/g, ' ').trim(), 160);
}

export const threadReplyDeps = {
  convexMutation,
  saveChatSession,
  startReply,
  endReply,
  stopReply,
};

export interface ThreadReplyContext {
  userId: string;
  userEmail?: string | null;
  userName?: string | null;
  sessionId: string;
  workId: string;
  turn: string;
  /** The `updatedAt` of the thread copy the client loaded; 0 keeps every stored message. */
  baseUpdatedAt: number;
}

/** Start a thread reply: register its stop control and mark the thread "Answering". */
export async function beginThreadReply(context: ThreadReplyContext, deps = threadReplyDeps) {
  const controller = deps.startReply(context.userId, context.sessionId, context.turn);
  await deps
    .convexMutation(api.albatrossThreads.replyStarted, {
      userId: context.userId,
      workId: context.workId,
      turn: context.turn,
    })
    .catch(() => undefined);
  return controller;
}

/** The reply ended (finished, failed, or stopped): save the thread and update the list. */
export async function finishThreadReply(
  context: ThreadReplyContext,
  event: { messages: UIMessage[]; responseMessage: UIMessage; isAborted: boolean },
  deps = threadReplyDeps,
) {
  deps.endReply(context.userId, context.sessionId, context.turn);
  try {
    await runWithAiRequestContext(
      {
        userId: context.userId,
        userEmail: context.userEmail ?? undefined,
        userName: context.userName ?? undefined,
        agent: 'ai',
      },
      () =>
        deps.saveChatSession(
          context.sessionId,
          event.messages,
          undefined,
          { kind: 'work', workId: context.workId },
          { baseUpdatedAt: context.baseUpdatedAt },
        ),
    );
  } finally {
    await deps
      .convexMutation(api.albatrossThreads.replyEnded, {
        userId: context.userId,
        workId: context.workId,
        turn: context.turn,
        waits: !event.isAborted && replyWaitsForUser(event.responseMessage),
        preview: replyPreviewText(event.responseMessage) || undefined,
      })
      .catch(() => undefined);
  }
}

/** The chat Stop button (T11): stop the server reply and clear "Answering". */
export async function stopThreadReply(
  input: { userId: string; sessionId: string; workId: string },
  deps = threadReplyDeps,
) {
  const turn = deps.stopReply(input.userId, input.sessionId);
  if (turn)
    await deps
      .convexMutation(api.albatrossThreads.replyEnded, {
        userId: input.userId,
        workId: input.workId,
        turn,
        waits: false,
      })
      .catch(() => undefined);
  return Boolean(turn);
}

/**
 * Keep a note to a run in its thread (docs/albatross-threads.md, T7, T10): a
 * user message with `metadata.steer`, and no chat turn. The server writes it,
 * so a note sent from a list row on any device shows in the thread. The id is
 * the client's message id when it sent one, so the thread's own save merges
 * with this one instead of adding the note twice.
 */
export async function appendThreadNote(
  input: {
    userId: string;
    userEmail?: string | null;
    userName?: string | null;
    workId: string;
    runId: string;
    note: string;
    noteId?: string | null;
    redirect?: boolean;
  },
  deps: Pick<typeof threadReplyDeps, 'saveChatSession'> = threadReplyDeps,
) {
  const at = Date.now();
  const message = {
    id: input.noteId?.trim() || `note-${input.runId}-${at}`,
    role: 'user' as const,
    parts: [{ type: 'text' as const, text: input.note }],
    metadata: { createdAt: at, steer: { runId: input.runId, ...(input.redirect ? { redirect: true } : {}) } },
  };
  await runWithAiRequestContext(
    {
      userId: input.userId,
      userEmail: input.userEmail ?? undefined,
      userName: input.userName ?? undefined,
      agent: 'ai',
    },
    () =>
      deps.saveChatSession(
        workThreadSessionId(input.workId),
        [message as unknown as UIMessage],
        undefined,
        { kind: 'work', workId: input.workId },
        // Base 0 keeps every stored message: this save only adds the note.
        { baseUpdatedAt: 0 },
      ),
  );
  return message.id;
}
