import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api, internal } from '../convex/_generated/api';
import { driveGoogleSub, SECURITY_REASONS } from '../convex/googleSecurity';
import schema from '../convex/schema';
import { RISC_EVENT_TYPES } from '../lib/google/risc';
import { refreshTokenIdentifiers } from '../lib/google/token-identifiers';

const convexModules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/cloudFiles.ts': () => import('../convex/cloudFiles'),
  '../convex/googleDirect.ts': () => import('../convex/googleDirect'),
  '../convex/googleSecurity.ts': () => import('../convex/googleSecurity'),
  '../convex/mailOutbox.ts': () => import('../convex/mailOutbox'),
};

const SECRET = 'google-security-runtime-secret';
const USER = 'user_ann';
const ACCOUNT = 'acct-ann';
const GRANT = 'google:11111111-1111-4111-8111-111111111111';
const SUB = '110248495921238986420';
const DRIVE = 'google_drive_ann';
let previousSecret: string | undefined;

beforeAll(() => {
  previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});

afterAll(() => {
  if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
});

type Harness = ReturnType<typeof newHarness>;

function newHarness() {
  return convexTest(schema, convexModules);
}

async function seedMail(
  t: Harness,
  input: {
    userId?: string;
    accountId?: string;
    grantId?: string;
    email?: string;
    googleSub?: string;
    refreshToken?: string;
    accountGrantId?: string;
  } = {},
) {
  const userId = input.userId ?? USER;
  const accountId = input.accountId ?? ACCOUNT;
  const grantId = input.grantId ?? GRANT;
  const email = input.email ?? 'ann@example.com';
  await t.run(async (ctx) => {
    const ts = Date.now();
    await ctx.db.insert('connectedAccounts', {
      userId,
      accountId,
      email,
      provider: 'google',
      status: 'connected',
      scopes: [],
      grantId: input.accountGrantId ?? grantId,
      createdAt: ts,
      updatedAt: ts,
    });
    await ctx.db.insert('providerGrants', {
      userId,
      accountId,
      provider: 'google',
      grantId,
      email,
      accessTokenEncrypted: 'enc-access',
      refreshTokenEncrypted: 'enc-refresh',
      expiresAt: ts + 3_600_000,
      scopes: [],
      ...(input.googleSub === undefined
        ? { googleSub: SUB }
        : input.googleSub
          ? { googleSub: input.googleSub }
          : {}),
      ...refreshTokenIdentifiers(input.refreshToken ?? '1//0g-ann-refresh-token'),
      createdAt: ts,
      updatedAt: ts,
    });
  });
}

async function seedDrive(
  t: Harness,
  input: {
    userId?: string;
    connectionId?: string;
    googleSub?: string | null;
    accountKey?: string;
    email?: string;
    refreshToken?: string;
  } = {},
) {
  const userId = input.userId ?? USER;
  const connectionId = input.connectionId ?? DRIVE;
  await t.run(async (ctx) => {
    const ts = Date.now();
    await ctx.db.insert('cloudFileConnections', {
      userId,
      connectionId,
      provider: 'google_drive',
      accountKey: input.accountKey ?? SUB,
      accountEmail: input.email ?? 'ann@example.com',
      status: 'connected',
      scopes: [],
      ...(input.googleSub === null ? {} : { googleSub: input.googleSub ?? SUB }),
      createdAt: ts,
      updatedAt: ts,
    });
    await ctx.db.insert('cloudFileCredentials', {
      userId,
      connectionId,
      provider: 'google_drive',
      accessTokenEncrypted: 'enc-drive-access',
      refreshTokenEncrypted: 'enc-drive-refresh',
      ...refreshTokenIdentifiers(input.refreshToken ?? '1//0g-drive-refresh-token'),
      createdAt: ts,
      updatedAt: ts,
    });
  });
}

function record(
  t: Harness,
  input: {
    jti?: string;
    apply?: boolean;
    name: keyof typeof RISC_EVENT_TYPES;
    action: 'revoke' | 'hold' | 'release' | 'reconnect' | 'log';
    subject: Record<string, string>;
  },
) {
  return t.mutation(api.googleSecurity.recordSecurityEvent, {
    internalSecret: SECRET,
    jti: input.jti ?? `jti-${Math.random()}`,
    issuedAt: Date.now() - 1000,
    apply: input.apply ?? true,
    events: [
      {
        type: RISC_EVENT_TYPES[input.name],
        name: input.name,
        action: input.action,
        subject: input.subject,
      },
    ],
  });
}

async function snapshot(t: Harness) {
  return await t.run(async (ctx) => ({
    accounts: await ctx.db.query('connectedAccounts').collect(),
    grants: await ctx.db.query('providerGrants').collect(),
    drives: await ctx.db.query('cloudFileConnections').collect(),
    credentials: await ctx.db.query('cloudFileCredentials').collect(),
    events: await ctx.db.query('googleSecurityEvents').collect(),
    audit: await ctx.db.query('googleSecurityAudit').collect(),
  }));
}

describe('recordSecurityEvent', () => {
  test('needs the internal secret', async () => {
    const t = newHarness();
    await expect(
      t.mutation(api.googleSecurity.recordSecurityEvent, {
        jti: 'x',
        apply: true,
        events: [],
      }),
    ).rejects.toThrow('Invalid Convex internal secret');
  });

  test('with the flag off it records the matches and changes nothing', async () => {
    const t = newHarness();
    await seedMail(t);
    await seedDrive(t);
    const result = await record(t, {
      jti: 'jti-off',
      apply: false,
      name: 'tokens-revoked',
      action: 'revoke',
      subject: { sub: SUB },
    });
    expect(result).toEqual({
      duplicate: false,
      matchedMail: 1,
      matchedDrive: 1,
      applied: 0,
      forgetGrantIds: [],
    });
    const after = await snapshot(t);
    expect(after.grants[0]?.refreshTokenEncrypted).toBe('enc-refresh');
    expect(after.accounts[0]?.status).toBe('connected');
    expect(after.credentials).toHaveLength(1);
    expect(after.audit).toEqual([]);
    expect(after.events).toHaveLength(1);
    expect(after.events[0]).toMatchObject({
      jti: 'jti-off',
      eventNames: ['tokens-revoked'],
      mode: 'logged',
      matchedMail: 1,
      matchedDrive: 1,
      applied: 0,
    });
    // No subject data on the event row.
    expect(JSON.stringify(after.events[0])).not.toContain(SUB);
  });

  test('is idempotent by jti', async () => {
    const t = newHarness();
    await seedMail(t);
    await record(t, {
      jti: 'jti-dup',
      apply: false,
      name: 'tokens-revoked',
      action: 'revoke',
      subject: { sub: SUB },
    });
    const second = await record(t, {
      jti: 'jti-dup',
      name: 'tokens-revoked',
      action: 'revoke',
      subject: { sub: SUB },
    });
    expect(second).toEqual({
      duplicate: true,
      matchedMail: 0,
      matchedDrive: 0,
      applied: 0,
      forgetGrantIds: [],
    });
    const after = await snapshot(t);
    expect(after.events).toHaveLength(1);
    expect(after.grants[0]?.refreshTokenEncrypted).toBe('enc-refresh');
  });

  test('tokens-revoked deletes the tokens, asks for a reconnect, and writes an audit row', async () => {
    const t = newHarness();
    await seedMail(t);
    await seedDrive(t);
    const result = await record(t, {
      jti: 'jti-revoke',
      name: 'tokens-revoked',
      action: 'revoke',
      subject: { sub: SUB },
    });
    expect(result).toEqual({
      duplicate: false,
      matchedMail: 1,
      matchedDrive: 1,
      applied: 2,
      forgetGrantIds: [GRANT],
    });
    const after = await snapshot(t);
    const grant = after.grants[0]!;
    expect(grant.accessTokenEncrypted).toBeUndefined();
    expect(grant.refreshTokenEncrypted).toBeUndefined();
    expect(grant.refreshTokenPrefixHash).toBeUndefined();
    expect(grant.googleSub).toBe(SUB);
    expect(grant.securityEvent).toBe('tokens-revoked');
    expect(after.accounts[0]).toMatchObject({
      status: 'error',
      error: SECURITY_REASONS.revoke,
      errorSinceSource: 'status_change',
    });
    expect(after.credentials).toEqual([]);
    expect(after.drives[0]).toMatchObject({
      status: 'error',
      error: SECURITY_REASONS.revoke,
      securityEvent: 'tokens-revoked',
    });
    expect(after.audit.map((row) => [row.target, row.action, row.userId])).toEqual([
      ['mail', 'tokens_deleted', USER],
      ['drive', 'tokens_deleted', USER],
    ]);
    expect(after.events[0]).toMatchObject({ mode: 'applied', applied: 2 });

    // The History refresh of another instance cannot write a token back.
    const saved = await t.mutation(api.googleDirect.saveGrantAccessToken, {
      internalSecret: SECRET,
      userId: USER,
      accountId: ACCOUNT,
      grantId: GRANT,
      accessTokenEncrypted: 'enc-late',
      expiresAt: Date.now() + 3_600_000,
    });
    expect(saved).toEqual({ updated: 0 });
    // The Drive refresh finds no credentials and fails.
    const updated = await t.mutation(api.cloudFiles.updateCredentials, {
      internalSecret: SECRET,
      userId: USER,
      connectionId: DRIVE,
      accessTokenEncrypted: 'enc-late',
    });
    expect(updated).toEqual({ ok: false });
  });

  test('account-disabled sets a hold, and account-enabled clears it', async () => {
    const t = newHarness();
    await seedMail(t);
    await seedDrive(t);
    await record(t, { name: 'account-disabled', action: 'hold', subject: { sub: SUB } });
    let after = await snapshot(t);
    expect(after.grants[0]?.securityHoldAt).toBeNumber();
    expect(after.grants[0]?.refreshTokenEncrypted).toBeUndefined();
    expect(after.accounts[0]?.error).toBe(SECURITY_REASONS.hold);
    expect(after.drives[0]?.securityHoldAt).toBeNumber();
    expect(after.drives[0]?.error).toBe(SECURITY_REASONS.hold);
    expect(after.audit.map((row) => row.action)).toEqual([
      'tokens_deleted_hold_set',
      'tokens_deleted_hold_set',
    ]);

    const enabled = await record(t, { name: 'account-enabled', action: 'release', subject: { sub: SUB } });
    expect(enabled.applied).toBe(2);
    after = await snapshot(t);
    expect(after.grants[0]?.securityHoldAt).toBeUndefined();
    expect(after.grants[0]?.securityEvent).toBe('account-enabled');
    expect(after.accounts[0]).toMatchObject({ status: 'error', error: SECURITY_REASONS.release });
    expect(after.drives[0]).toMatchObject({ status: 'error', error: SECURITY_REASONS.release });
    expect(after.drives[0]?.securityHoldAt).toBeUndefined();

    // A second account-enabled has no hold to clear.
    const again = await record(t, { name: 'account-enabled', action: 'release', subject: { sub: SUB } });
    expect(again.applied).toBe(0);
  });

  test('a release keeps another error text, and a new sign-in ends the hold', async () => {
    const t = newHarness();
    await seedMail(t);
    await record(t, { name: 'account-disabled', action: 'hold', subject: { sub: SUB } });
    await t.run(async (ctx) => {
      const account = await ctx.db.query('connectedAccounts').first();
      await ctx.db.patch(account!._id, { error: 'Reconnect needed: the mailbox sign-in expired' });
    });
    await record(t, { name: 'account-enabled', action: 'release', subject: { sub: SUB } });
    let after = await snapshot(t);
    expect(after.accounts[0]?.error).toBe('Reconnect needed: the mailbox sign-in expired');

    await record(t, { name: 'account-disabled', action: 'hold', subject: { sub: SUB } });
    const ids = refreshTokenIdentifiers('1//0g-new-refresh');
    await t.mutation(api.googleDirect.activateGoogleAccount, {
      internalSecret: SECRET,
      userId: USER,
      mode: 'reconnect',
      accountId: ACCOUNT,
      newAccountId: 'unused',
      newGrantId: 'google:unused',
      email: 'ann@example.com',
      scopes: ['openid'],
      accessTokenEncrypted: 'enc-access-2',
      refreshTokenEncrypted: 'enc-refresh-2',
      expiresAt: Date.now() + 3_600_000,
      historyId: '10',
      googleSub: SUB,
      ...ids,
    });
    after = await snapshot(t);
    expect(after.grants[0]).toMatchObject({
      grantId: GRANT,
      refreshTokenEncrypted: 'enc-refresh-2',
      googleSub: SUB,
      ...ids,
    });
    expect(after.grants[0]?.securityHoldAt).toBeUndefined();
    expect(after.grants[0]?.securityEvent).toBeUndefined();
    expect(after.accounts[0]).toMatchObject({ status: 'connected' });
  });

  test('credential-change-required asks for a reconnect and keeps the tokens', async () => {
    const t = newHarness();
    await seedMail(t);
    await seedDrive(t);
    await record(t, { name: 'credential-change-required', action: 'reconnect', subject: { sub: SUB } });
    let after = await snapshot(t);
    expect(after.grants[0]?.refreshTokenEncrypted).toBe('enc-refresh');
    expect(after.accounts[0]).toMatchObject({ status: 'error', error: SECURITY_REASONS.reconnect });
    expect(after.credentials).toHaveLength(1);
    expect(after.drives[0]).toMatchObject({ status: 'error', error: SECURITY_REASONS.reconnect });
    expect(after.audit.map((row) => row.action)).toEqual(['reconnect_marked', 'reconnect_marked']);

    // A good Drive call does not end the reconnect state.
    await t.mutation(api.cloudFiles.markAccessed, {
      internalSecret: SECRET,
      userId: USER,
      connectionId: DRIVE,
    });
    after = await snapshot(t);
    expect(after.drives[0]).toMatchObject({ status: 'error', error: SECURITY_REASONS.reconnect });
    expect(after.drives[0]?.lastAccessedAt).toBeNumber();

    // A new Drive connection does.
    await t.mutation(api.cloudFiles.upsertConnection, {
      internalSecret: SECRET,
      userId: USER,
      connectionId: DRIVE,
      provider: 'google_drive',
      accountKey: SUB,
      accountEmail: 'ann@example.com',
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
      accessTokenEncrypted: 'enc-new',
    });
    after = await snapshot(t);
    expect(after.drives[0]).toMatchObject({ status: 'connected', googleSub: SUB });
    expect(after.drives[0]?.securityEvent).toBeUndefined();
    // No new refresh token: the stored one and its identifiers stay.
    expect(after.credentials[0]).toMatchObject({
      refreshTokenEncrypted: 'enc-drive-refresh',
      ...refreshTokenIdentifiers('1//0g-drive-refresh-token'),
    });
  });

  test('token-revoked matches one refresh token by its prefix or its double hash', async () => {
    const t = newHarness();
    await seedMail(t, { refreshToken: '1//0g-first-refresh-token' });
    await seedMail(t, {
      userId: 'user_bo',
      accountId: 'acct-bo',
      grantId: 'google:22222222-2222-4222-8222-222222222222',
      googleSub: '999',
      email: 'bo@example.com',
      refreshToken: '1//0g-second-refresh-token',
    });
    await seedDrive(t, { refreshToken: '1//0g-drive-refresh-token' });
    const first = refreshTokenIdentifiers('1//0g-first-refresh-token');
    const byPrefix = await record(t, {
      name: 'token-revoked',
      action: 'revoke',
      subject: { tokenPrefixHash: first.refreshTokenPrefixHash! },
    });
    expect(byPrefix).toMatchObject({ matchedMail: 1, matchedDrive: 0, forgetGrantIds: [GRANT] });
    const drive = refreshTokenIdentifiers('1//0g-drive-refresh-token');
    const byHash = await record(t, {
      name: 'token-revoked',
      action: 'revoke',
      subject: { tokenDoubleHash: drive.refreshTokenDoubleHash! },
    });
    expect(byHash).toMatchObject({ matchedMail: 0, matchedDrive: 1 });
    const after = await snapshot(t);
    expect(after.grants.find((row) => row.userId === 'user_bo')?.refreshTokenEncrypted).toBe('enc-refresh');
    expect(after.grants.find((row) => row.userId === USER)?.refreshTokenEncrypted).toBeUndefined();
    expect(after.credentials).toEqual([]);
  });

  test('an email subject matches only when the event has no sub, and never a Nylas account', async () => {
    const t = newHarness();
    await seedMail(t, { googleSub: '' });
    await seedDrive(t, { googleSub: null, email: 'ann@example.com' });
    await t.run(async (ctx) => {
      const ts = Date.now();
      // The same address on Nylas, under another user.
      await ctx.db.insert('connectedAccounts', {
        userId: 'user_nylas',
        accountId: 'acct-nylas',
        email: 'ann@example.com',
        provider: 'google',
        status: 'connected',
        scopes: [],
        grantId: 'nylas-grant-1',
        createdAt: ts,
        updatedAt: ts,
      });
    });
    const result = await record(t, {
      apply: false,
      name: 'tokens-revoked',
      action: 'revoke',
      subject: { email: 'Ann@Example.com' },
    });
    expect(result).toMatchObject({ matchedMail: 1, matchedDrive: 1 });
    const none = await record(t, { apply: false, name: 'tokens-revoked', action: 'revoke', subject: {} });
    expect(none).toMatchObject({ matchedMail: 0, matchedDrive: 0 });
  });

  test('a token row whose account moved to another grant is not matched', async () => {
    const t = newHarness();
    await seedMail(t, { accountGrantId: 'nylas-rolled-back' });
    const result = await record(t, { name: 'tokens-revoked', action: 'revoke', subject: { sub: SUB } });
    expect(result).toMatchObject({ matchedMail: 0, applied: 0 });
  });

  test('sessions-revoked and verification only log', async () => {
    const t = newHarness();
    await seedMail(t);
    const result = await record(t, { name: 'sessions-revoked', action: 'log', subject: { sub: SUB } });
    expect(result).toMatchObject({ matchedMail: 1, applied: 0 });
    const after = await snapshot(t);
    expect(after.accounts[0]?.status).toBe('connected');
    expect(after.events[0]).toMatchObject({ mode: 'applied', applied: 0 });
  });
});

describe('retention and backfill', () => {
  test('the sweep deletes expired event and audit rows', async () => {
    const t = newHarness();
    await t.run(async (ctx) => {
      const ts = Date.now();
      await ctx.db.insert('googleSecurityEvents', {
        jti: 'old',
        eventNames: ['verification'],
        receivedAt: ts - 1,
        mode: 'logged',
        matchedMail: 0,
        matchedDrive: 0,
        applied: 0,
        expiresAt: ts - 1,
      });
      await ctx.db.insert('googleSecurityEvents', {
        jti: 'new',
        eventNames: ['verification'],
        receivedAt: ts,
        mode: 'logged',
        matchedMail: 0,
        matchedDrive: 0,
        applied: 0,
        expiresAt: ts + 60_000,
      });
      await ctx.db.insert('googleSecurityAudit', {
        userId: USER,
        jti: 'old',
        eventName: 'tokens-revoked',
        target: 'mail',
        action: 'tokens_deleted',
        createdAt: ts - 1,
        expiresAt: ts - 1,
      });
    });
    expect(await t.mutation(internal.googleSecurity.sweepExpired, {})).toEqual({ deleted: 2 });
    const after = await snapshot(t);
    expect(after.events.map((row) => row.jti)).toEqual(['new']);
    expect(after.audit).toEqual([]);
  });

  test('the Drive backfill copies a numeric account key into googleSub', async () => {
    const t = newHarness();
    await seedDrive(t, { googleSub: null, accountKey: '1234567890' });
    await seedDrive(t, { connectionId: 'drive-email', googleSub: null, accountKey: 'ann@example.com' });
    expect(await t.mutation(internal.googleSecurity.backfillDriveGoogleSub, { dryRun: true })).toMatchObject({
      scanned: 2,
      changed: 1,
      done: true,
    });
    let after = await snapshot(t);
    expect(after.drives.every((row) => row.googleSub === undefined)).toBe(true);
    await t.mutation(internal.googleSecurity.backfillDriveGoogleSub, {});
    after = await snapshot(t);
    expect(after.drives.map((row) => row.googleSub)).toEqual(['1234567890', undefined]);
    expect(driveGoogleSub({ provider: 'onedrive', accountKey: '1234567890' })).toBeUndefined();
  });

  test('a Drive refresh stores the token identifiers and fills googleSub', async () => {
    const t = newHarness();
    await seedDrive(t, { googleSub: null, accountKey: '1234567890' });
    const ids = refreshTokenIdentifiers('1//0g-rotated');
    expect(
      await t.mutation(api.cloudFiles.updateCredentials, {
        internalSecret: SECRET,
        userId: USER,
        connectionId: DRIVE,
        accessTokenEncrypted: 'enc-fresh',
        refreshTokenEncrypted: 'enc-rotated',
        ...ids,
      }),
    ).toEqual({ ok: true });
    const after = await snapshot(t);
    expect(after.credentials[0]).toMatchObject({ refreshTokenEncrypted: 'enc-rotated', ...ids });
    expect(after.drives[0]?.googleSub).toBe('1234567890');
  });

  test('a mail refresh fills googleSub once and stores the token identifiers', async () => {
    const t = newHarness();
    await seedMail(t, { googleSub: '' });
    const ids = refreshTokenIdentifiers('1//0g-mail-rotated');
    const save = (googleSub: string) =>
      t.mutation(api.googleDirect.saveGrantAccessToken, {
        internalSecret: SECRET,
        userId: USER,
        accountId: ACCOUNT,
        grantId: GRANT,
        accessTokenEncrypted: 'enc-fresh',
        expiresAt: Date.now() + 3_600_000,
        googleSub,
        ...ids,
      });
    expect(await save(SUB)).toEqual({ updated: 1 });
    expect(await save('another-sub')).toEqual({ updated: 1 });
    const after = await snapshot(t);
    expect(after.grants[0]).toMatchObject({ googleSub: SUB, accessTokenEncrypted: 'enc-fresh', ...ids });
    const credentials = await t.query(api.googleDirect.getGrantCredentials, {
      internalSecret: SECRET,
      grantId: GRANT,
    });
    expect(credentials?.googleSub).toBe(SUB);
  });
});
