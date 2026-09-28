import { afterEach, describe, expect, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import {
  __setGoogleSharedGrantDepsForTest,
  driveUsesMailGrant,
  mailSharesDriveClient,
  mailUsesDriveGrant,
} from '../lib/google/shared-grant';

const DRIVE_ONLY = { GOOGLE_DRIVE_CLIENT_ID: 'drive-client', GOOGLE_DRIVE_CLIENT_SECRET: 'drive-secret' };
const SEPARATE = {
  ...DRIVE_ONLY,
  GOOGLE_MAIL_CLIENT_ID: 'mail-client',
  GOOGLE_MAIL_CLIENT_SECRET: 'mail-secret',
};

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

describe('mailSharesDriveClient', () => {
  test('mail shares the Drive client unless a separate mail client is set', () => {
    expect(mailSharesDriveClient(DRIVE_ONLY)).toBe(true);
    expect(mailSharesDriveClient(SEPARATE)).toBe(false);
    expect(mailSharesDriveClient({ ...SEPARATE, GOOGLE_MAIL_CLIENT_ID: 'drive-client' })).toBe(true);
    expect(mailSharesDriveClient({})).toBe(false);
    expect(mailSharesDriveClient({ GOOGLE_MAIL_CLIENT_ID: 'm', GOOGLE_MAIL_CLIENT_SECRET: 's' })).toBe(false);
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

  test('a separate mail client never shares, and a failed check keeps the grant', async () => {
    const queries = setup(SEPARATE, { drive });
    expect(await driveUsesMailGrant({ userId: 'u1', email: 'ann@example.com' })).toBe(false);
    expect(queries).toEqual([]);
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

  test('a separate mail client never shares, and a failed check keeps the grant', async () => {
    setup(SEPARATE, { mail });
    expect(await mailUsesDriveGrant({ userId: 'u1', email: 'ann@example.com' })).toBe(false);
    setup(DRIVE_ONLY, { fail: true });
    expect(await mailUsesDriveGrant({ userId: 'u1', email: 'ann@example.com' })).toBe(true);
  });
});
