import { runWithAiRequestContext } from '../ai/context';
import { type InverseOp, recordOperation, registerUndoExecutor } from '../ai/operations';
import { api, convexMutation } from '../hosted/convex';
import { convexInternalSecret, isConvexConfigured } from '../hosted/env';
import { revertNylasMessageFolders, revertNylasThreadFolders } from '../nylas/provider';
import { truncateText } from '../shared/text';
import type { Thread } from '../shared/types';
import { setSmartRuleEnabled } from '../store/smart-rules';
import { unsnoozeThread } from '../store/snooze';
import { replaceThreadTriage, resolveThread } from '../store/threads';

// Mail undo parity (FEATURES item 10). Every mail change that Albatross or the
// user makes records one operation with a reason and an inverse, so Activity
// can show it and take it back. The inverse kinds below are the only mail
// inverses; each has one executor, registered when this module loads.

export const MAIL_UNDO = {
  threadFolders: 'mail.restore_thread_folders',
  messageFolders: 'mail.restore_message_folders',
  unsnooze: 'mail.unsnooze',
  disableRule: 'mail.disable_smart_rule',
  restoreTriage: 'mail.restore_triage',
  unblockSender: 'mail.unblock_sender',
} as const;

/** One thread folder change, as the provider reported it. */
export interface ThreadFolderChange {
  account: string;
  threadId: string;
  before: string[];
  after: string[];
}

export interface MessageFolderChange {
  account: string;
  messageId: string;
  before: string[];
  after: string[];
}

export interface TriageChange {
  account: string;
  threadId: string;
  previous: Thread['triage'] | null;
}

export interface RuleUndo {
  ruleId: string;
  scope: string;
  match: string;
}

export interface MailOperationInput {
  userId: string | null | undefined;
  tool: string;
  summary: string;
  reason?: string;
  target: Record<string, unknown>;
  inverse?: InverseOp;
  batchId?: string;
}

/**
 * Records a mail operation. Without a hosted Convex there is no operations
 * log, and the primary change must not fail because of that.
 */
export async function recordMailOperation(
  input: MailOperationInput,
  recorder: typeof recordOperation = recordOperation,
): Promise<string | undefined> {
  if (!input.userId) return undefined;
  if (recorder === recordOperation && (!isConvexConfigured() || !convexInternalSecret())) return undefined;
  const id = await recorder({
    userId: input.userId,
    tool: input.tool,
    surface: 'mail',
    summary: truncateText(input.summary, 240),
    reason: input.reason?.trim() ? input.reason.trim().slice(0, 300) : undefined,
    target: input.target,
    inverse: input.inverse,
    batchId: input.batchId,
  });
  return id || undefined;
}

/** The reason line for an operation: the caller's words, or who asked. */
export function mailOperationReason(
  ctx: { agent?: 'user' | 'ai' | 'codex' },
  explicit?: string | null,
): string | undefined {
  const given = String(explicit || '').trim();
  if (given) return given.slice(0, 300);
  if (ctx.agent === 'ai') return 'Albatross did this while working on your request.';
  return undefined;
}

function clip(text: string, max: number) {
  const value = text.replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

/** `"Subject"` for a summary, or `a thread` when the subject is unknown. */
export function quotedSubject(subject: string | null | undefined) {
  const value = clip(String(subject || ''), 80);
  return value ? `"${value}"` : 'a thread';
}

/** The subject of a thread for an Activity summary. Never throws. */
export async function threadSubject(account: string, threadId: string): Promise<string | null> {
  try {
    const thread = await resolveThread(account, threadId);
    return thread?.subject?.trim() || null;
  } catch {
    return null;
  }
}

/** "Fri, Oct 2, 9:00 AM" in the user's zone. */
export function formatWakeTime(untilTs: number, timeZone?: string) {
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  };
  try {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone }).format(new Date(untilTs));
  } catch {
    return new Intl.DateTimeFormat('en-US', options).format(new Date(untilTs));
  }
}

export function pluralThreads(count: number) {
  return `${count} ${count === 1 ? 'thread' : 'threads'}`;
}

/** Only real changes are worth an undo entry. */
export function changedFolders(change: { before: string[]; after: string[] }) {
  const before = [...new Set(change.before)].sort().join('\u0000');
  const after = [...new Set(change.after)].sort().join('\u0000');
  return before !== after;
}

/** Runs `run` over `items` with at most `limit` in flight. Keeps input order. */
export async function mapLimit<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>) {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: 'fulfilled', value: await run(items[index]) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

export interface MailUndoDependencies {
  revertThread: typeof revertNylasThreadFolders;
  revertMessage: typeof revertNylasMessageFolders;
  unsnooze: typeof unsnoozeThread;
  disableRule: (ruleId: string) => Promise<unknown>;
  reclassify: (userId: string, rule: { scope: string; match: string }) => Promise<unknown>;
  replaceTriage: typeof replaceThreadTriage;
}

const defaultDependencies: MailUndoDependencies = {
  revertThread: revertNylasThreadFolders,
  revertMessage: revertNylasMessageFolders,
  unsnooze: unsnoozeThread,
  disableRule: (ruleId) => setSmartRuleEnabled(ruleId, false),
  reclassify: (userId, rule) =>
    convexMutation(api.smart.reclassifyMatchingThreads, {
      userId,
      scope: rule.scope,
      match: rule.match,
    }),
  replaceTriage: replaceThreadTriage,
};

function failureMessage(failed: number, total: number, noun: string) {
  return failed === total
    ? `Could not restore ${total === 1 ? `the ${noun}` : `the ${total} ${noun}s`}.`
    : `Restored ${total - failed} of ${total} ${noun}s. ${failed} could not be restored.`;
}

async function revertThreads(userId: string, threads: ThreadFolderChange[], deps: MailUndoDependencies) {
  const list = Array.isArray(threads) ? threads : [];
  const results = await mapLimit(list, 4, async (change) => {
    const result = await deps.revertThread({
      userId,
      account: change.account,
      threadId: change.threadId,
      before: change.before || [],
      after: change.after || [],
    });
    if (!result) throw new Error('Connected Nylas account not found.');
    return result;
  });
  const failed = results.filter((result) => result.status === 'rejected').length;
  if (failed) throw new Error(failureMessage(failed, list.length, 'thread'));
}

/** The mail undo executors. Exported with injectable dependencies for tests. */
export function createMailUndoExecutors(deps: MailUndoDependencies = defaultDependencies) {
  // Store helpers read the user from the ambient request context.
  const asUser = <T>(userId: string, run: () => Promise<T>) =>
    runWithAiRequestContext({ userId, agent: 'user' }, run);
  const disableRule = async (userId: string, rule: RuleUndo) => {
    await asUser(userId, () => deps.disableRule(rule.ruleId));
    // Best effort: the scheduled reclassify sweep converges regardless.
    await deps.reclassify(userId, rule).catch(() => undefined);
  };
  return {
    async [MAIL_UNDO.threadFolders](
      payload: { threads: ThreadFolderChange[]; messages?: MessageFolderChange[] },
      ctx: { userId: string },
    ) {
      await revertThreads(ctx.userId, payload?.threads || [], deps);
      for (const message of payload?.messages || []) {
        const result = await deps.revertMessage({ userId: ctx.userId, ...message });
        if (!result) throw new Error('Connected Nylas account not found.');
      }
    },
    async [MAIL_UNDO.messageFolders](payload: MessageFolderChange, ctx: { userId: string }) {
      if (!payload?.messageId) throw new Error('messageId required.');
      const result = await deps.revertMessage({
        userId: ctx.userId,
        account: payload.account,
        messageId: payload.messageId,
        before: payload.before || [],
        after: payload.after || [],
      });
      if (!result) throw new Error('Connected Nylas account not found.');
    },
    async [MAIL_UNDO.unsnooze](payload: { account: string; threadId: string }, ctx: { userId: string }) {
      if (!payload?.threadId) throw new Error('threadId required.');
      await deps.unsnooze({ userId: ctx.userId, account: payload.account, threadId: payload.threadId });
    },
    async [MAIL_UNDO.disableRule](payload: RuleUndo, ctx: { userId: string }) {
      if (!payload?.ruleId) throw new Error('ruleId required.');
      await disableRule(ctx.userId, payload);
    },
    async [MAIL_UNDO.restoreTriage](payload: { items: TriageChange[] }, ctx: { userId: string }) {
      const items = Array.isArray(payload?.items) ? payload.items : [];
      await asUser(ctx.userId, async () => {
        for (const item of items) {
          await deps.replaceTriage(item.account, item.threadId, item.previous ?? null);
        }
      });
    },
    async [MAIL_UNDO.unblockSender](
      payload: RuleUndo & { threads?: ThreadFolderChange[] },
      ctx: { userId: string },
    ) {
      if (!payload?.ruleId) throw new Error('ruleId required.');
      await disableRule(ctx.userId, payload);
      if (payload.threads?.length) await revertThreads(ctx.userId, payload.threads, deps);
    },
  };
}

const executors = createMailUndoExecutors();
for (const kind of Object.values(MAIL_UNDO)) {
  registerUndoExecutor(kind, (payload, ctx) => (executors as any)[kind](payload, ctx));
}
