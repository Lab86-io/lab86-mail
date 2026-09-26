import { api, convexMutation, convexQuery } from '../hosted/convex';
import { moveNylasThread, updateNylasThread } from '../nylas/provider';

// Snooze (MUT-1). Snoozing moves the thread out of the inbox at the provider
// (archive), and a Convex row remembers when it comes back. The mail snooze
// cron calls restoreDueSnoozes, which moves due threads back to the inbox and
// marks them unread so they surface again.

const corpusApi = (api as any).mailCorpus;

export interface SnoozeDependencies {
  query: typeof convexQuery;
  mutate: typeof convexMutation;
  moveThread: typeof moveNylasThread;
  updateThread: typeof updateNylasThread;
}

const defaults: SnoozeDependencies = {
  query: convexQuery,
  mutate: convexMutation,
  moveThread: moveNylasThread,
  updateThread: updateNylasThread,
};

async function requireProvider<T>(value: Promise<T | null>): Promise<T> {
  const result = await value;
  if (!result) throw new Error('Connected Nylas account not found.');
  return result;
}

export async function snoozeThread(
  input: { userId: string; account: string; threadId: string; messageId?: string; untilTs: number },
  deps: SnoozeDependencies = defaults,
) {
  if (!(input.untilTs > Date.now())) throw new Error('Choose a snooze time in the future.');
  await requireProvider(
    deps.moveThread({
      userId: input.userId,
      account: input.account,
      threadId: input.threadId,
      to: 'archive',
    }),
  );
  try {
    await deps.mutate(corpusApi.createSnooze, {
      userId: input.userId,
      accountId: input.account,
      threadId: input.threadId,
      messageId: input.messageId,
      untilTs: input.untilTs,
    });
  } catch (err) {
    // Without a record nothing would bring the thread back; undo the move.
    await deps
      .moveThread({ userId: input.userId, account: input.account, threadId: input.threadId, to: 'inbox' })
      .catch(() => undefined);
    throw err;
  }
  return { untilTs: input.untilTs };
}

/** Cancels the snooze and moves the thread back to the inbox now. */
export async function unsnoozeThread(
  input: { userId: string; account: string; threadId?: string; messageId?: string },
  deps: SnoozeDependencies = defaults,
) {
  if (!input.threadId && !input.messageId) throw new Error('threadId or messageId is required.');
  const cancelled = await deps.mutate<{ threadIds: string[] }>(corpusApi.cancelSnooze, {
    userId: input.userId,
    accountId: input.account,
    threadId: input.threadId,
    messageId: input.messageId,
  });
  const threadIds = [
    ...new Set([...(cancelled?.threadIds || []), ...(input.threadId ? [input.threadId] : [])]),
  ];
  for (const threadId of threadIds) {
    await requireProvider(
      deps.moveThread({ userId: input.userId, account: input.account, threadId, to: 'inbox' }),
    );
  }
  return { restored: threadIds.length };
}

/** Moves every due snoozed thread back to the inbox. Run by the cron route. */
export async function restoreDueSnoozes(deps: SnoozeDependencies = defaults) {
  const due = await deps.query<
    Array<{ id: string; userId: string; accountId: string; threadId: string; attempts: number }>
  >(corpusApi.listDueSnoozes, { limit: 50 });
  let restored = 0;
  let failed = 0;
  for (const snooze of due || []) {
    try {
      const target = { userId: snooze.userId, account: snooze.accountId, threadId: snooze.threadId };
      await requireProvider(deps.moveThread({ ...target, to: 'inbox' }));
      await deps.updateThread({ ...target, unread: true }).catch(() => undefined);
      await deps.mutate(corpusApi.settleSnooze, { id: snooze.id, ok: true });
      restored += 1;
    } catch (err: any) {
      failed += 1;
      await deps
        .mutate(corpusApi.settleSnooze, { id: snooze.id, ok: false, error: String(err?.message || err) })
        .catch(() => undefined);
    }
  }
  return { restored, failed };
}
