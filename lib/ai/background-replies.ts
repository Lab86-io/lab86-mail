// Chat replies that run on the server after the browser leaves
// (docs/albatross-threads.md, T5, T11). Each Work thread reply registers its
// abort controller here, so the chat Stop button stops the reply on the
// server too, not only the stream on one device. The registry lives in this
// process: the hosted app runs one web process.

interface Reply {
  controller: AbortController;
  turn: string;
}

const replies = new Map<string, Reply>();

function key(userId: string, sessionId: string) {
  return `${userId}:${sessionId}`;
}

/** Start a reply. A newer reply in the same thread stops the older one. */
export function startReply(userId: string, sessionId: string, turn: string): AbortController {
  const id = key(userId, sessionId);
  replies.get(id)?.controller.abort();
  const controller = new AbortController();
  replies.set(id, { controller, turn });
  return controller;
}

/** Forget a reply that ended. A newer reply of the same thread stays. */
export function endReply(userId: string, sessionId: string, turn: string) {
  const id = key(userId, sessionId);
  if (replies.get(id)?.turn === turn) replies.delete(id);
}

/** Stop the running reply of a thread. Returns the turn that was stopped, or null. */
export function stopReply(userId: string, sessionId: string): string | null {
  const id = key(userId, sessionId);
  const reply = replies.get(id);
  if (!reply) return null;
  reply.controller.abort();
  replies.delete(id);
  return reply.turn;
}

/** True when a reply of this thread runs in this process. */
export function replyRunning(userId: string, sessionId: string) {
  return replies.has(key(userId, sessionId));
}
