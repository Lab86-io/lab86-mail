import { afterEach, describe, expect, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import {
  __setGoogleSharedGrantDepsForTest,
  driveUsesMailGrant,
  googleClientProject,
  googleRevokeBlockedReason,
  googleRevokeEnvironmentAllowed,
  mailSharesDriveProject,
  mailUsesDriveGrant,
} from '../lib/google/shared-grant';

const DRIVE_CLIENT = '452431903621-drive.apps.googleusercontent.com';
const DRIVE_ONLY = { GOOGLE_DRIVE_CLIENT_ID: DRIVE_CLIENT, GOOGLE_DRIVE_CLIENT_SECRET: 'drive-secret' };
// A mail client in another Google Cloud project: a revoke there cannot end Drive.
const SEPARATE = {
  ...DRIVE_ONLY,
  GOOGLE_MAIL_CLIENT_ID: '111111111111-mail.apps.googleusercontent.com',
  GOOGLE_MAIL_CLIENT_SECRET: 'mail-secret',
};
// A second client in the Drive project: Google revokes for every client of the project.
const SAME_PROJECT = { ...SEPARATE, GOOGLE_MAIL_CLIENT_ID: '452431903621-mail.apps.googleusercontent.com' };

afterEach(() => __setGoogleSharedGrantDepsForTest());

function setup(env: Record<string, string>, answers: { drive?: unknown; mail?: unknown; fail?: boolean }) {
  const queries: string[] = [];
  __setGoogleSharedGrantDepsForTest({
    env: () => env,
    query: (async (fn: unknown, args: any) => {
      const name = getFunctionName(fn as any);
      queries.push(`${name}:${args.userId}`);
      if (answers.fail) throw new Error('convex down');
      return name === 'cloudFiles:listConnections' ? answers.drive : answers.mail;
    }) as any,
  });
  return queries;
}

describe('mailSharesDriveProject', () => {
  test('the project number is the numeric head of a client id', () => {
    expect(googleClientProject(DRIVE_CLIENT)).toBe('452431903621');
    expect(googleClientProject(' 42-x.apps.googleusercontent.com ')).toBe('42');
    expect(googleClientProject('drive-client')).toBeNull();
    expect(googleClientProject(undefined)).toBeNull();
  });

  test('mail shares with Drive unless its client is in another Google Cloud project', () => {
    expect(mailSharesDriveProject(DRIVE_ONLY)).toBe(true);
    expect(mailSharesDriveProject(SAME_PROJECT)).toBe(true);
    expect(mailSharesDriveProject(SEPARATE)).toBe(false);
    expect(mailSharesDriveProject({ ...SEPARATE, GOOGLE_MAIL_CLIENT_ID: DRIVE_CLIENT })).toBe(true);
    // A client id with no project number is an unclear case, and it counts as shared.
    expect(mailSharesDriveProject({ ...SEPARATE, GOOGLE_MAIL_CLIENT_ID: 'mail-client' })).toBe(true);
    expect(mailSharesDriveProject({ ...SEPARATE, GOOGLE_DRIVE_CLIENT_ID: 'drive-client' })).toBe(true);
    expect(mailSharesDriveProject({})).toBe(false);
    expect(mailSharesDriveProject({ GOOGLE_MAIL_CLIENT_ID: 'm', GOOGLE_MAIL_CLIENT_SECRET: 's' })).toBe(
      false,
    );
  });
});

describe('driveUsesMailGrant (before a mail revoke)', () => {
  const drive = [
    { provider: 'onedrive', accountEmail: 'ann@example.com' },
    { provider: 'google_drive', accountEmail: 'Ann@Example.com' },
  ];

  test('a Google Drive connection of the same address shares the grant', async () => {
    const queries = setup(DRIVE_ONLY, { drive });
    expect(await driveUsesMailGrant({ userId: 'u1', email: 'ann@example.com' })).toBe(true);
    expect(queries).toEqual(['cloudFiles:listConnections:u1']);
    expect(await driveUsesMailGrant({ userId: 'u1', email: 'bo@example.com' })).toBe(false);
    expect(await driveUsesMailGrant({ userId: 'u1', email: '' })).toBe(false);
    setup(DRIVE_ONLY, { drive: null });
    expect(await driveUsesMailGrant({ userId: 'u1', email: 'ann@example.com' })).toBe(false);
  });

  test('a mail client in another project never shares, and a failed check keeps the grant', async () => {
    const queries = setup(SEPARATE, { drive });
    expect(await driveUsesMailGrant({ userId: 'u1', email: 'ann@example.com' })).toBe(false);
    expect(queries).toEqual([]);
    // A second client in the same project still shares: the revoke is for the project.
    setup(SAME_PROJECT, { drive });
    expect(await driveUsesMailGrant({ userId: 'u1', email: 'ann@example.com' })).toBe(true);
    setup(DRIVE_ONLY, { fail: true });
    expect(await driveUsesMailGrant({ userId: 'u1', email: 'ann@example.com' })).toBe(true);
  });
});

describe('mailUsesDriveGrant (before a Drive revoke)', () => {
  const mail = [
    { provider: 'google', email: 'ann@example.com', grantId: 'nylas-grant', status: 'connected' },
    { provider: 'google', email: 'bo@example.com', grantId: 'google:g-bo', status: 'disconnected' },
    { provider: 'google', email: 'Ann@Example.com', grantId: 'google:g-ann', status: 'error' },
  ];

  test('a direct Google mail account of the same address shares the grant, also in the reconnect state', async () => {
    const queries = setup(DRIVE_ONLY, { mail });
    expect(await mailUsesDriveGrant({ userId: 'u1', email: 'ann@example.com' })).toBe(true);
    expect(queries).toEqual(['accounts:listConnectedAccounts:u1']);
    // A Nylas grant and a disconnected account do not count.
    expect(await mailUsesDriveGrant({ userId: 'u1', email: 'bo@example.com' })).toBe(false);
    setup(DRIVE_ONLY, { mail: [mail[0]] });
    expect(await mailUsesDriveGrant({ userId: 'u1', email: 'ann@example.com' })).toBe(false);
    setup(DRIVE_ONLY, { mail: undefined });
    expect(await mailUsesDriveGrant({ userId: 'u1', email: undefined })).toBe(false);
  });

  test('a mail client in another project never shares, and a failed check keeps the grant', async () => {
    setup(SEPARATE, { mail });
    expect(await mailUsesDriveGrant({ userId: 'u1', email: 'ann@example.com' })).toBe(false);
    setup(SAME_PROJECT, { mail });
    expect(await mailUsesDriveGrant({ userId: 'u1', email: 'ann@example.com' })).toBe(true);
    setup(DRIVE_ONLY, { fail: true });
    expect(await mailUsesDriveGrant({ userId: 'u1', email: 'ann@example.com' })).toBe(true);
  });
});

describe('googleRevokeBlockedReason', () => {
  function gate(env: Record<string, string>, answer: boolean | 'fail') {
    const asked: unknown[] = [];
    __setGoogleSharedGrantDepsForTest({
      env: () => env,
      query: (async (_fn: unknown, args: any) => {
        asked.push(args.email);
        if (answer === 'fail') throw new Error('convex down');
        return answer;
      }) as any,
    });
    return asked;
  }

  test('only production, or the explicit switch, may revoke', () => {
    expect(googleRevokeEnvironmentAllowed({ RAILWAY_ENVIRONMENT_NAME: 'production' })).toBe(true);
    expect(googleRevokeEnvironmentAllowed({ RAILWAY_ENVIRONMENT_NAME: 'development' })).toBe(false);
    expect(googleRevokeEnvironmentAllowed({})).toBe(false);
    expect(googleRevokeEnvironmentAllowed({ LAB86_GOOGLE_REVOKE: '1' })).toBe(true);
  });

  test('staging never revokes and does not ask Convex', async () => {
    const asked = gate({ RAILWAY_ENVIRONMENT_NAME: 'development' }, false);
    expect(await googleRevokeBlockedReason({ email: 'ann@example.com' })).toContain(
      'production Google project',
    );
    expect(asked).toEqual([]);
  });

  test('production revokes only when no Nylas grant uses the address', async () => {
    gate({ RAILWAY_ENVIRONMENT_NAME: 'production' }, false);
    expect(await googleRevokeBlockedReason({ email: 'ann@example.com' })).toBeNull();
    const asked = gate({ RAILWAY_ENVIRONMENT_NAME: 'production' }, true);
    expect(await googleRevokeBlockedReason({ email: 'ann@example.com' })).toContain('Nylas grant');
    expect(asked).toEqual(['ann@example.com']);
  });

  test('an unknown address or a failed check blocks the revoke', async () => {
    gate({ RAILWAY_ENVIRONMENT_NAME: 'production' }, false);
    expect(await googleRevokeBlockedReason({ email: ' ' })).toContain('not known');
    expect(await googleRevokeBlockedReason({})).toContain('not known');
    gate({ RAILWAY_ENVIRONMENT_NAME: 'production' }, 'fail');
    expect(await googleRevokeBlockedReason({ email: 'ann@example.com' })).toContain('check failed');
  });
});
