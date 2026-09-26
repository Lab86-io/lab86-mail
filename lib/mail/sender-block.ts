import { api, convexMutation, convexQuery } from '../hosted/convex';
import { moveNylasThread } from '../nylas/provider';
import { emailFromHeader } from '../shared/format';
import type { SmartRule } from '../shared/types';
import { createSmartRule, listSmartRules } from '../store/smart-rules';
import {
  changedFolders,
  MAIL_UNDO,
  mailOperationReason,
  mapLimit,
  pluralThreads,
  recordMailOperation,
  type ThreadFolderChange,
} from './mail-operations';

// Block sender (FEATURES item 13): an always-Noise rule for the address, and
// the sender's mail already in the inbox moves to the archive. One operation
// records both, so Undo turns the rule off and brings the threads back.

/** The most inbox threads one block archives. Older ones stay where they are. */
export const BLOCK_ARCHIVE_LIMIT = 100;

export interface BlockSenderDependencies {
  listRules: () => Promise<SmartRule[]>;
  createRule: typeof createSmartRule;
  reclassify: (userId: string, rule: { scope: string; match: string }) => Promise<unknown>;
  inboxThreads: (
    userId: string,
    sender: string,
    limit: number,
  ) => Promise<Array<{ accountId: string; threadId: string }>>;
  moveThread: typeof moveNylasThread;
  record: typeof recordMailOperation;
}

const defaultDependencies: BlockSenderDependencies = {
  listRules: () => listSmartRules(false),
  createRule: createSmartRule,
  reclassify: (userId, rule) =>
    convexMutation((api as any).smart.reclassifyMatchingThreads, { userId, ...rule }),
  inboxThreads: async (userId, sender, limit) =>
    (
      await convexQuery<{ threads: Array<{ accountId: string; threadId: string }> }>(
        (api as any).mailCorpus.inboxThreadsFromSender,
        { userId, sender, limit },
      )
    ).threads,
  moveThread: moveNylasThread,
  record: recordMailOperation,
};

export interface BlockSenderResult {
  ok: boolean;
  sender: string;
  ruleId: string;
  archived: number;
  failed: number;
  operationId?: string;
}

/** Blocks one sender address. Needs the user on the request context (rules live in the user store). */
export async function blockSender(
  input: {
    userId: string;
    sender: string;
    archiveExisting?: boolean;
    reason?: string;
    agent?: 'user' | 'ai' | 'codex';
    batchId?: string;
  },
  deps: BlockSenderDependencies = defaultDependencies,
): Promise<BlockSenderResult> {
  const sender = emailFromHeader(input.sender);
  if (!sender) throw new Error('Choose a sender address to block.');
  const existing = (await deps.listRules()).find(
    (rule) =>
      rule.enabled && rule.scope === 'sender' && rule.match === sender && rule.effect === 'always_noise',
  );
  const rule =
    existing ??
    (await deps.createRule({
      name: `Block ${sender}`,
      scope: 'sender',
      match: sender,
      effect: 'always_noise',
      category: 'noise',
      reason: 'Blocked sender',
      source: input.agent === 'ai' ? 'agent' : 'settings',
    }));
  await deps.reclassify(input.userId, { scope: rule.scope, match: rule.match }).catch(() => undefined);

  const changes: ThreadFolderChange[] = [];
  let failed = 0;
  if (input.archiveExisting !== false) {
    const threads = await deps.inboxThreads(input.userId, sender, BLOCK_ARCHIVE_LIMIT).catch(() => []);
    const results = await mapLimit(threads, 4, (thread) =>
      deps.moveThread({
        userId: input.userId,
        account: thread.accountId,
        threadId: thread.threadId,
        to: 'archive',
      }),
    );
    results.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value) {
        const change = {
          account: threads[index].accountId,
          threadId: threads[index].threadId,
          before: result.value.before,
          after: result.value.after,
        };
        if (changedFolders(change)) changes.push(change);
      } else failed += 1;
    });
  }

  const moved = changes.length ? `, and ${pluralThreads(changes.length)} left the inbox` : '';
  const operationId = await deps.record({
    userId: input.userId,
    tool: 'block_sender',
    summary: `Blocked ${sender}`,
    reason: mailOperationReason(
      { agent: input.agent },
      input.reason || `Mail from ${sender} goes to Noise from now on${moved}.`,
    ),
    target: { kind: 'sender', id: sender, count: changes.length },
    // A rule that was already there is not this block's to turn off.
    inverse: existing
      ? changes.length
        ? { kind: MAIL_UNDO.threadFolders, payload: { threads: changes } }
        : undefined
      : {
          kind: MAIL_UNDO.unblockSender,
          payload: { ruleId: rule._id, scope: rule.scope, match: rule.match, threads: changes },
        },
    batchId: input.batchId,
  });
  return { ok: failed === 0, sender, ruleId: rule._id, archived: changes.length, failed, operationId };
}
