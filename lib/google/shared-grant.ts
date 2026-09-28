// Direct Google transport: one Google grant for mail and Drive.
//
// Mail falls back to the Drive OAuth client (lib/google/oauth.ts). A Google
// token revoke removes all the access that the user gave to the Google Cloud
// project, for every OAuth client of that project. So a revoke from one
// feature also ends the other: a Drive disconnect would stop direct Gmail,
// and a mail disconnect would stop Drive. This is true for one shared client
// and for two clients in the same project. Before a revoke, each side asks
// here if the other side still has a connection of the same user and the
// same Google address in the same project. If yes, the caller deletes its own
// token row but does not revoke. Only a mail client in another Google Cloud
// project ends the sharing.

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

/**
 * The Google Cloud project number of an OAuth client id. A Google client id
 * has the form `<project number>-<id>.apps.googleusercontent.com`. Null for
 * an id of another form.
 */
export function googleClientProject(clientId: string | undefined): string | null {
  return /^(\d+)-/.exec(clientId?.trim() || '')?.[1] ?? null;
}

/**
 * True when a mail revoke can end the Drive grant, and the reverse: mail uses
 * the Drive client, or a mail client in the same Google Cloud project. A
 * client id with no project number counts as the same project, so an unclear
 * case never ends the other connection.
 */
export function mailSharesDriveProject(env: Env = deps.env()): boolean {
  const mail = googleOAuthClient(env);
  const driveId = env.GOOGLE_DRIVE_CLIENT_ID?.trim();
  if (!mail || !driveId) return false;
  if (mail.clientId === driveId) return true;
  const mailProject = googleClientProject(mail.clientId);
  const driveProject = googleClientProject(driveId);
  return !mailProject || !driveProject || mailProject === driveProject;
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
 * same address in the same project? A failed check counts as yes, so a doubt
 * never ends the other connection.
 */
export async function driveUsesMailGrant(input: { userId: string; email?: string }): Promise<boolean> {
  if (!mailSharesDriveProject()) return false;
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
 * for the same address in the same project? A failed check counts as yes.
 */
export async function mailUsesDriveGrant(input: { userId: string; email?: string }): Promise<boolean> {
  if (!mailSharesDriveProject()) return false;
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

/**
 * Only the production deployment revokes at Google. Staging and local
 * development use the production Google Cloud project, so a revoke there
 * would also end the production access for the same address.
 * `LAB86_GOOGLE_REVOKE=1` allows it for a deployment with its own project.
 */
export function googleRevokeEnvironmentAllowed(env: Env = deps.env()): boolean {
  return env.RAILWAY_ENVIRONMENT_NAME === 'production' || env.LAB86_GOOGLE_REVOKE === '1';
}

/**
 * The reason not to revoke a Google token of this address, or null when a
 * revoke is safe. A failed check is a reason, so a doubt never ends another
 * grant.
 */
export async function googleRevokeBlockedReason(input: { email?: string }): Promise<string | null> {
  if (!googleRevokeEnvironmentAllowed()) return 'this deployment shares the production Google project';
  if (!input.email?.trim()) return 'the Google address is not known';
  try {
    const used = await deps.query<boolean>(api.googleDirect.nylasGrantUsesAddress, { email: input.email });
    return used ? 'a Nylas grant in this deployment uses the same address' : null;
  } catch (err: any) {
    console.warn(
      '[google-shared-grant] Nylas grant check failed; the token is not revoked',
      err?.message || err,
    );
    return 'the Nylas grant check failed';
  }
}
