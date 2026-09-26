import { api, convexMutation } from '@/lib/hosted/convex';
import { MAIL_UNDO, recordMailOperation } from '@/lib/mail/mail-operations';
import { moveNylasMessage } from '@/lib/nylas/provider';

const oneTimeCodesApi = (api as any).mailOneTimeCodes;

export type CodeCleanupMode = 'none' | 'archive' | 'trash';

/**
 * A code id that does not resolve to a row for this user. Typed rather than
 * matched on message text, so a Convex error that merely happens to contain
 * "not found" cannot be misreported to the client as a 404.
 */
export class OneTimeCodeNotFoundError extends Error {
  constructor(message = 'Code not found.') {
    super(message);
    this.name = 'OneTimeCodeNotFoundError';
  }
}

export function parseCleanupMode(value: unknown): CodeCleanupMode {
  if (value === 'archive' || value === 'trash' || value === 'none') return value;
  // An unrecognised mode must not silently delete mail.
  return 'none';
}

export interface ConsumeOneTimeCodeResult {
  ok: true;
  cleanup: CodeCleanupMode;
  cleanupStatus: 'skipped' | 'archived' | 'trashed' | 'failed';
  alreadyUsed: boolean;
  error?: string;
}

interface ConsumeDependencies {
  mutate: typeof convexMutation;
  moveMessage: typeof moveNylasMessage;
  /** Activity entry with Undo for the cleanup move. */
  record?: typeof recordMailOperation;
}

const defaultDependencies: ConsumeDependencies = {
  mutate: convexMutation,
  moveMessage: moveNylasMessage,
};

/**
 * Marks a code used and, when the user asked for it, gets the mail that carried
 * it out of the way.
 *
 * The code is marked used before the mailbox is touched, and a cleanup failure
 * does not undo that: a code that has been handed to AutoFill is spent whether
 * or not its message could be filed, and re-offering it would be worse than
 * leaving the message in the inbox.
 */
export async function consumeOneTimeCode(
  input: { userId: string; codeId: string; cleanup: CodeCleanupMode },
  dependencies: ConsumeDependencies = defaultDependencies,
): Promise<ConsumeOneTimeCodeResult> {
  let used: {
    accountId: string;
    providerMessageId: string;
    providerThreadId: string;
    alreadyUsed: boolean;
    cleanup: string | null;
  };
  try {
    used = await dependencies.mutate(oneTimeCodesApi.markUsed, {
      userId: input.userId,
      codeId: input.codeId,
    });
  } catch (error) {
    // Convex raises a plain Error for both an unknown id and one belonging to
    // another user; both are "no such code for you" from the caller's side.
    const message = error instanceof Error ? error.message : String(error);
    if (/code not found/i.test(message)) throw new OneTimeCodeNotFoundError();
    throw error;
  }

  if (input.cleanup === 'none') {
    return { ok: true, cleanup: 'none', cleanupStatus: 'skipped', alreadyUsed: used.alreadyUsed };
  }
  // A retried consume must not file the message twice; the second call would
  // trash something the user had already pulled back out of the archive.
  if (used.cleanup === 'archived' || used.cleanup === 'trashed') {
    return {
      ok: true,
      cleanup: input.cleanup,
      cleanupStatus: used.cleanup,
      alreadyUsed: used.alreadyUsed,
    };
  }

  try {
    // Provider-aware move: Gmail edits labels, other providers change folder.
    const change = await dependencies.moveMessage({
      userId: input.userId,
      account: used.accountId,
      messageId: used.providerMessageId,
      to: input.cleanup === 'trash' ? 'trash' : 'archive',
    });
    const status = input.cleanup === 'trash' ? 'trashed' : 'archived';
    // An automatic cleanup is still a change to the user's mail: it shows in
    // Activity with Undo, like every other mail move.
    if (change?.before && change.after) {
      await (dependencies.record ?? recordMailOperation)({
        userId: input.userId,
        tool: 'one_time_code_cleanup',
        summary:
          status === 'trashed'
            ? 'Moved a used sign-in code email to Trash'
            : 'Archived a used sign-in code email',
        reason: 'The code was filled in, and your settings clear code emails after use.',
        target: { kind: 'message', id: used.providerMessageId, accountId: used.accountId },
        inverse: {
          kind: MAIL_UNDO.messageFolders,
          payload: {
            account: used.accountId,
            messageId: used.providerMessageId,
            before: change.before,
            after: change.after,
          },
        },
      }).catch(() => undefined);
    }
    await dependencies
      .mutate(oneTimeCodesApi.recordCleanup, {
        userId: input.userId,
        codeId: input.codeId,
        cleanup: status,
      })
      .catch(() => undefined);
    return { ok: true, cleanup: input.cleanup, cleanupStatus: status, alreadyUsed: used.alreadyUsed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await dependencies
      .mutate(oneTimeCodesApi.recordCleanup, {
        userId: input.userId,
        codeId: input.codeId,
        cleanup: 'failed',
        error: message,
      })
      .catch(() => undefined);
    return {
      ok: true,
      cleanup: input.cleanup,
      cleanupStatus: 'failed',
      alreadyUsed: used.alreadyUsed,
      error: message,
    };
  }
}
