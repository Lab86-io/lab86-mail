import { api, convexMutation, convexQuery } from '@/lib/hosted/convex';
import { deleteNylasAccount } from '@/lib/nylas/provider';

export interface AccountDeletionDeps {
  listConnectedAccounts(userId: string): Promise<Array<{ accountId: string; grantId?: string }>>;
  deleteNylasAccount(userId: string, accountId: string, grantId?: string): Promise<unknown>;
  deleteUserCascade(userId: string): Promise<unknown>;
}

export type DisconnectResult = { accountId: string; ok: boolean; error?: string };

export type AccountDeletionResult =
  | { ok: true; disconnected: DisconnectResult[]; cascade: unknown }
  | { ok: false; disconnected: DisconnectResult[] };

export const defaultAccountDeletionDeps: AccountDeletionDeps = {
  listConnectedAccounts: (userId) => convexQuery<any[]>(api.accounts.listConnectedAccounts, { userId }),
  deleteNylasAccount,
  deleteUserCascade: (userId) => convexMutation<any>((api as any).accounts.deleteUserCascade, { userId }),
};

/**
 * Removes every provider grant and all Convex data for one user. The Clerk
 * user itself is not touched: `DELETE /api/account` deletes it after this, and
 * the Clerk `user.deleted` webhook runs this after Clerk already deleted it.
 * Each step is safe to run again, so a failed run can be retried.
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
  // Deleting the local linkage while a provider grant is still active would
  // orphan that grant with no way to clean it up later — stop here instead.
  if (disconnected.some((item) => !item.ok)) return { ok: false, disconnected };
  const cascade = await deps.deleteUserCascade(userId);
  return { ok: true, disconnected, cascade };
}
