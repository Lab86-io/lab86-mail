import { forgetSavedSignIns } from '@/lib/albatross/browser-contexts';
import { disconnectCloudFileConnection, listCloudFileConnections } from '@/lib/files/connections';
import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { deleteNylasAccount } from '@/lib/nylas/provider';

export interface AccountDeletionDeps {
  listConnectedAccounts(userId: string): Promise<Array<{ accountId: string; grantId?: string }>>;
  deleteNylasAccount(userId: string, accountId: string, grantId?: string): Promise<unknown>;
  listCloudFileConnections(userId: string): Promise<Array<{ connectionId: string; provider?: string }>>;
  disconnectCloudFileConnection(userId: string, connectionId: string): Promise<{ revoked: boolean }>;
  /** Deletes the saved sign-ins (the Browserbase context) of the shared browser. */
  forgetSavedSignIns(userId: string): Promise<{ pending?: number } | unknown>;
  deleteUserCascade(userId: string): Promise<unknown>;
}

export type DisconnectResult = { accountId: string; ok: boolean; error?: string };
export type DriveDisconnectResult = {
  connectionId: string;
  ok: boolean;
  revoked?: boolean;
  error?: string;
};

export type AccountDeletionResult =
  | {
      ok: true;
      disconnected: DisconnectResult[];
      drives: DriveDisconnectResult[];
      signIns?: { ok: boolean; pending?: number; error?: string };
      cascade: unknown;
    }
  | {
      ok: false;
      disconnected: DisconnectResult[];
      drives: DriveDisconnectResult[];
      signIns?: { ok: boolean; pending?: number; error?: string };
    };

export const defaultAccountDeletionDeps: AccountDeletionDeps = {
  listConnectedAccounts: (userId) => convexQuery<any[]>(api.accounts.listConnectedAccounts, { userId }),
  deleteNylasAccount,
  listCloudFileConnections,
  disconnectCloudFileConnection,
  forgetSavedSignIns: (userId) => forgetSavedSignIns(userId),
  deleteUserCascade: (userId) => convexMutation<any>(api.accounts.deleteUserCascade, { userId }),
};

/**
 * Removes every provider grant and all Convex data for one user. The Clerk
 * user itself is not touched: `DELETE /api/account` deletes it after this, and
 * the Clerk `user.deleted` webhook runs this after Clerk already deleted it.
 * Each step is safe to run again, so a failed run can be retried.
 *
 * Mailboxes go first, then file connections. A Google Drive disconnect
 * revokes the Drive token at Google with the rules of a Drive disconnect
 * (lib/google/shared-grant.ts): only in production, and not while another
 * Google connection in this deployment uses the same address. The mailboxes
 * of this user are gone at that point, so they do not block the revoke.
 */
export async function deleteUserData(
  userId: string,
  deps: AccountDeletionDeps = defaultAccountDeletionDeps,
): Promise<AccountDeletionResult> {
  const accounts = await deps.listConnectedAccounts(userId);
  const disconnected: DisconnectResult[] = [];
  for (const row of accounts) {
    try {
      await deps.deleteNylasAccount(userId, row.accountId, row.grantId);
      disconnected.push({ accountId: row.accountId, ok: true });
    } catch (err: any) {
      disconnected.push({ accountId: row.accountId, ok: false, error: err?.message || 'disconnect failed' });
    }
  }
  const drives: DriveDisconnectResult[] = [];
  // Deleting the local linkage while a provider grant is still active would
  // orphan that grant with no way to clean it up later — stop here instead.
  if (disconnected.some((item) => !item.ok)) return { ok: false, disconnected, drives };
  for (const connection of (await deps.listCloudFileConnections(userId)) || []) {
    try {
      const result = await deps.disconnectCloudFileConnection(userId, connection.connectionId);
      drives.push({ connectionId: connection.connectionId, ok: true, revoked: result?.revoked === true });
    } catch (err: any) {
      drives.push({
        connectionId: connection.connectionId,
        ok: false,
        error: err?.message || 'disconnect failed',
      });
    }
  }
  if (drives.some((item) => !item.ok)) return { ok: false, disconnected, drives };
  // The saved sign-ins live at Browserbase. Forgetting them records each
  // context in a deletion row without a userId, which outlives the cascade,
  // so a remote delete that fails now is retried hourly until it succeeds.
  // Only a failure to record them stops here for a retry.
  let signIns: { ok: boolean; pending?: number; error?: string };
  try {
    const forgotten = (await deps.forgetSavedSignIns(userId)) as { pending?: number } | undefined;
    signIns = { ok: true, pending: Number(forgotten?.pending) || 0 };
  } catch (err: any) {
    signIns = { ok: false, error: err?.message || 'saved sign-ins could not be deleted' };
    return { ok: false, disconnected, drives, signIns };
  }
  const cascade = await deps.deleteUserCascade(userId);
  return { ok: true, disconnected, drives, signIns, cascade };
}
