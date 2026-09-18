import { api, convexMutation, convexQuery } from '../hosted/convex';
import { evidenceSatisfies } from './evidence-gate';
import { isReplyCandidate, type ReplyMessage, type ReplyWatch } from './reply-watch';

interface Dependencies {
  convexQuery: typeof convexQuery;
  convexMutation: typeof convexMutation;
  evidenceSatisfies: typeof evidenceSatisfies;
}

/** Shared by scheduled watches and every brief, before the brief reads Work state. */
export async function checkWaitingReplies(
  input: { userId: string; workId?: string },
  deps: Dependencies = { convexQuery, convexMutation, evidenceSatisfies },
) {
  const state = await deps.convexQuery<{
    selfEmails: string[];
    watches: Array<{ workId: string; title: string; watch: ReplyWatch }>;
  }>((api as any).albatrossReplies.waiting, input);
  const pending = new Map(state.watches.map((row) => [row.workId, row]));
  const result = { watched: pending.size, resumed: 0, unavailable: false };
  if (!pending.size) return result;
  const after = Math.min(...state.watches.map((row) => row.watch.after));
  let cursor: string | null = null;
  do {
    const page: { page: Array<ReplyMessage & { _id: string }>; isDone: boolean; continueCursor: string } =
      await deps.convexQuery((api as any).albatrossReplies.messages, {
        userId: input.userId,
        after,
        paginationOpts: { cursor, numItems: 100 },
      });
    for (const message of page.page) {
      for (const row of pending.values()) {
        if (!isReplyCandidate(row.watch, message, state.selfEmails)) continue;
        const verdict = await deps.evidenceSatisfies({
          userId: input.userId,
          workTitle: row.title,
          requirement: `A substantive incoming reply from ${row.watch.senderEmails.join(', ')} that lets this work continue: ${row.watch.requirement}. Automatic acknowledgements, out-of-office messages, marketing, quoted old messages, and unrelated topics do not satisfy this.`,
          evidenceText: JSON.stringify({
            from: message.from,
            subject: message.subject,
            sameThread: message.providerThreadId === row.watch.threadId,
            body: message.textBody || message.snippet,
          }),
        });
        if (verdict.unavailable) {
          result.unavailable = true;
          continue;
        }
        if (!verdict.satisfies) continue;
        const saved = await deps.convexMutation<{ resumed: boolean }>((api as any).albatrossReplies.resume, {
          userId: input.userId,
          workId: row.workId,
          watchId: row.watch.id,
          messageId: message._id,
          reason: verdict.reason,
        });
        if (saved.resumed) result.resumed += 1;
        pending.delete(row.workId);
      }
    }
    if (page.isDone || !pending.size) break;
    cursor = page.continueCursor;
  } while (cursor);
  return result;
}
