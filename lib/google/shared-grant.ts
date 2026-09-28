// Direct Google transport: one Google grant for mail and Drive.
//
// Mail falls back to the Drive OAuth client (lib/google/oauth.ts). Google
// keeps one grant for a user and a client, so a token revoke from one feature
// also ends the other: a Drive disconnect would stop direct Gmail, and a mail
// disconnect would stop Drive. Before a revoke, each side asks here if the
// other side still has a connection of the same user and the same Google
// address on the same client. If yes, the caller deletes its own token row
// but does not revoke. A separate GOOGLE_MAIL_CLIENT_ID ends the sharing.

import { api, convexQuery } from '@/lib/hosted/convex';
import { googleOAuthClient } from './oauth';
import { isGoogleDirectGrant } from './transport';

type Env = Record<string, string | undefined>;

const defaults = {
  query: convexQuery,
  env: (): Env => process.env,
};
let deps = defaults;

export function __setGoogleSharedGrantDepsForTest(overrides: Partial<typeof defaults> = {}) {
  deps = { ...defaults, ...overrides };
}

/** True when mail uses the Drive OAuth client (no separate mail client). */
export function mailSharesDriveClient(env: Env = deps.env()): boolean {
  const mail = googleOAuthClient(env);
  const driveId = env.GOOGLE_DRIVE_CLIENT_ID?.trim();
  return Boolean(mail && driveId && mail.clientId === driveId);
}

function sameAddress(a: unknown, b: unknown) {
  return (
    typeof a === 'string' &&
    typeof b === 'string' &&
    a.trim() !== '' &&
    a.trim().toLowerCase() === b.trim().toLowerCase()
  );
}

/**
 * Before a mail revoke: does the user have a Google Drive connection for the
 * same address on the same client? A failed check counts as yes, so a doubt
 * never ends the other connection.
 */
export async function driveUsesMailGrant(input: { userId: string; email?: string }): Promise<boolean> {
  if (!mailSharesDriveClient()) return false;
  try {
    const rows = await deps.query<Array<{ provider?: string; accountEmail?: string }>>(
      api.cloudFiles.listConnections,
      { userId: input.userId },
    );
    return (rows || []).some(
      (row) => row.provider === 'google_drive' && sameAddress(row.accountEmail, input.email),
    );
  } catch (err: any) {
    console.warn('[google-shared-grant] Drive check failed; the token is not revoked', err?.message || err);
    return true;
  }
}

/**
 * Before a Drive revoke: does the user have a direct Google mail connection
 * for the same address on the same client? A failed check counts as yes.
 */
export async function mailUsesDriveGrant(input: { userId: string; email?: string }): Promise<boolean> {
  if (!mailSharesDriveClient()) return false;
  try {
    const rows = await deps.query<
      Array<{ provider?: string; email?: string; grantId?: string; status?: string }>
    >(api.accounts.listConnectedAccounts, { userId: input.userId });
    return (rows || []).some(
      (row) =>
        row.provider === 'google' &&
        isGoogleDirectGrant(row.grantId) &&
        row.status !== 'disconnected' &&
        sameAddress(row.email, input.email),
    );
  } catch (err: any) {
    console.warn('[google-shared-grant] mail check failed; the token is not revoked', err?.message || err);
    return true;
  }
}
