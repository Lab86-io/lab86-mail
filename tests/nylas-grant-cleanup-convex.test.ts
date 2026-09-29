import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api, internal } from '../convex/_generated/api';
import schema from '../convex/schema';

// googleDirect:nylasGrantCleanupPlan and googleDirect:clearPreviousNylasGrant
// (docs/google-direct-transport.md, "Cleanup").

const convexModules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/googleDirect.ts': () => import('../convex/googleDirect'),
  '../convex/mailOutbox.ts': () => import('../convex/mailOutbox'),
};

const SECRET = 'nylas-cleanup-runtime-secret';
const USER = 'user_cleanup';
const USER_B = 'user_cleanup_b';
const ACCOUNT = 'dc636c8d-1660-4cfb-b7ab-8c10811f98a8';
const NYLAS_GRANT = 'd502cbfc-98b3-49f4-93a7-d0a5d825d7fa';
const GRANT = 'google:11111111-1111-4111-8111-111111111111';
const GRANT_B = 'google:22222222-2222-4222-8222-222222222222';
const HOUR = 3_600_000;
let previousSecret: string | undefined;

beforeAll(() => {
  previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});

afterAll(() => {
  if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
});

function newHarness() {
  return convexTest(schema, convexModules);
}

type Harness = ReturnType<typeof newHarness>;

async function seedNylasAccount(t: Harness, userId = USER, accountId = ACCOUNT, grantId = NYLAS_GRANT) {
  await t.run(async (ctx) => {
    const ts = Date.now();
    await ctx.db.insert('connectedAccounts', {
      userId,
      accountId,
      email: 'ann@example.com',
      provider: 'google',
      status: 'connected',
      scopes: ['email'],
      grantId,
      createdAt: ts,
      updatedAt: ts,
    } as any);
    await ctx.db.insert('providerGrants', {
      userId,
      accountId,
      provider: 'google',
      grantId,
      email: 'ann@example.com',
      scopes: ['email'],
      createdAt: ts - 30 * 24 * HOUR,
      updatedAt: ts,
    });
  });
}

async function switchAccount(t: Harness, userId = USER, newGrantId = GRANT) {
  return await t.mutation(api.googleDirect.activateGoogleAccount, {
    internalSecret: SECRET,
    userId,
    mode: 'switch',
    accountId: ACCOUNT,
    newAccountId: 'unused',
    newGrantId,
    email: 'ann@example.com',
    scopes: ['openid'],
    accessTokenEncrypted: 'enc-access',
    refreshTokenEncrypted: 'enc-refresh',
    expiresAt: Date.now() + HOUR,
    historyId: '1000',
  });
}

async function grantRow(t: Harness, userId = USER) {
  return await t.run(async (ctx) =>
    ctx.db
      .query('providerGrants')
      .withIndex('by_user_account', (q) => q.eq('userId', userId).eq('accountId', ACCOUNT))
      .unique(),
  );
}

async function patchRows(t: Harness, userId: string, patch: { account?: any; grant?: any }) {
  await t.run(async (ctx) => {
    const account = await ctx.db
      .query('connectedAccounts')
      .withIndex('by_user_account', (q) => q.eq('userId', userId).eq('accountId', ACCOUNT))
      .unique();
    const grant = await ctx.db
      .query('providerGrants')
      .withIndex('by_user_account', (q) => q.eq('userId', userId).eq('accountId', ACCOUNT))
      .unique();
    if (patch.account && account) await ctx.db.patch(account._id, patch.account);
    if (patch.grant && grant) await ctx.db.patch(grant._id, patch.grant);
  });
}

const planForAccount = (t: Harness, userId = USER) =>
  t.query(api.googleDirect.nylasGrantCleanupPlan, { internalSecret: SECRET, userId, accountId: ACCOUNT });
const planByAge = (t: Harness, switchedBefore: number) =>
  t.query(api.googleDirect.nylasGrantCleanupPlan, { internalSecret: SECRET, switchedBefore });

describe('switch time', () => {
  test('a switch records its time; a reconnect keeps it; a rollback clears it', async () => {
    const t = newHarness();
    await seedNylasAccount(t);
    const before = Date.now();
    await switchAccount(t);
    const switched = await grantRow(t);
    expect(switched?.previousNylasGrantId).toBe(NYLAS_GRANT);
    expect(switched?.switchedToGoogleAt).toBeGreaterThanOrEqual(before);

    await t.mutation(api.googleDirect.activateGoogleAccount, {
      internalSecret: SECRET,
      userId: USER,
      mode: 'reconnect',
      accountId: ACCOUNT,
      newAccountId: 'unused',
      newGrantId: 'google:33333333-3333-4333-8333-333333333333',
      email: 'ann@example.com',
      scopes: ['openid'],
      accessTokenEncrypted: 'enc-access-2',
      refreshTokenEncrypted: 'enc-refresh-2',
      expiresAt: Date.now() + HOUR,
      historyId: '2000',
    });
    expect((await grantRow(t))?.switchedToGoogleAt).toBe(switched?.switchedToGoogleAt);

    await t.mutation(internal.googleDirect.rollbackToNylas, { userId: USER, accountId: ACCOUNT });
    const rolledBack = await grantRow(t);
    expect(rolledBack?.grantId).toBe(NYLAS_GRANT);
    expect(rolledBack?.switchedToGoogleAt).toBeUndefined();
  });
});

describe('cleanup plan for one account', () => {
  test('a healthy switched account can let its Nylas grant go, at any age', async () => {
    const t = newHarness();
    await seedNylasAccount(t);
    await switchAccount(t);
    const plan = await planForAccount(t);
    expect(plan.truncated).toBe(false);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({
      nylasGrantId: NYLAS_GRANT,
      eligible: true,
      connections: [{ userId: USER, accountId: ACCOUNT, email: 'ann@example.com', grantId: GRANT }],
    });
  });

  test('refuses an account that is not on a direct google: grant', async () => {
    const t = newHarness();
    await seedNylasAccount(t);
    await patchRows(t, USER, { grant: { previousNylasGrantId: 'older-nylas-grant' } });
    const [item] = (await planForAccount(t)).items;
    expect(item).toMatchObject({ eligible: false, nylasGrantId: 'older-nylas-grant' });
    expect(item.reason).toContain('does not use a direct Google grant');
  });

  test('refuses an unknown account, an account with no Nylas grant, and a cleaned one', async () => {
    const t = newHarness();
    const missing = await planForAccount(t);
    expect(missing.items[0]).toMatchObject({
      nylasGrantId: null,
      eligible: false,
      reason: 'The account was not found.',
    });

    await seedNylasAccount(t);
    await switchAccount(t);
    await patchRows(t, USER, { grant: { previousNylasGrantId: undefined } });
    expect((await planForAccount(t)).items[0]).toMatchObject({
      eligible: false,
      reason: 'The account keeps no Nylas grant.',
    });

    await patchRows(t, USER, { grant: { nylasGrantRevokedAt: Date.UTC(2026, 8, 29) } });
    expect((await planForAccount(t)).items[0].reason).toBe(
      'The cleanup deleted the Nylas grant at 2026-09-29T00:00:00.000Z.',
    );
  });

  test('keeps the grant for a direct connection that is not healthy, or whose account row differs', async () => {
    const t = newHarness();
    await seedNylasAccount(t);
    await switchAccount(t);
    await patchRows(t, USER, { account: { status: 'error' } });
    const [unhealthy] = (await planForAccount(t)).items;
    expect(unhealthy.eligible).toBe(false);
    expect(unhealthy.reason).toContain('status "error"');

    await patchRows(t, USER, { account: { status: 'connected', grantId: GRANT_B } });
    expect((await planForAccount(t)).items[0].reason).toContain('account row does not use');
  });

  test('keeps a grant that a connection is still on, or that another switched connection keeps', async () => {
    const t = newHarness();
    await seedNylasAccount(t);
    await seedNylasAccount(t, USER_B);
    await switchAccount(t);
    // User B is still on the Nylas grant.
    const [inUse] = (await planForAccount(t)).items;
    expect(inUse).toMatchObject({ eligible: false, reason: 'A connection still uses this Nylas grant.' });

    // User B switched too: B's rollback needs the same Nylas grant.
    await switchAccount(t, USER_B, GRANT_B);
    const [shared] = (await planForAccount(t)).items;
    expect(shared.eligible).toBe(false);
    expect(shared.reason).toContain('Another connection keeps this Nylas grant');
    expect(shared.connections.map((row) => row.userId).sort()).toEqual([USER, USER_B]);
  });

  test('needs the secret and a clear target', async () => {
    const t = newHarness();
    await expect(
      t.query(api.googleDirect.nylasGrantCleanupPlan, { internalSecret: 'wrong', switchedBefore: 1 }),
    ).rejects.toThrow('Invalid Convex internal secret.');
    await expect(
      t.query(api.googleDirect.nylasGrantCleanupPlan, { internalSecret: SECRET, userId: USER }),
    ).rejects.toThrow('Name both the userId and the accountId.');
    await expect(
      t.query(api.googleDirect.nylasGrantCleanupPlan, {
        internalSecret: SECRET,
        userId: USER,
        accountId: ACCOUNT,
        switchedBefore: 1,
      }),
    ).rejects.toThrow('Not both');
    await expect(t.query(api.googleDirect.nylasGrantCleanupPlan, { internalSecret: SECRET })).rejects.toThrow(
      'Name one account, or a switch time.',
    );
  });
});

describe('cleanup plan by age', () => {
  test('lists each kept Nylas grant once, and only old switches are eligible', async () => {
    const t = newHarness();
    await seedNylasAccount(t);
    await switchAccount(t);
    const switchedAt = (await grantRow(t))!.switchedToGoogleAt!;

    const early = await planByAge(t, switchedAt - HOUR);
    expect(early.items).toHaveLength(1);
    expect(early.items[0]).toMatchObject({ eligible: false, reason: 'A connection switched too recently.' });

    const late = await planByAge(t, switchedAt + HOUR);
    expect(late.items[0]).toMatchObject({ nylasGrantId: NYLAS_GRANT, eligible: true });
  });

  test('a switch with no recorded time needs the account mode', async () => {
    const t = newHarness();
    await seedNylasAccount(t);
    await switchAccount(t);
    await patchRows(t, USER, { grant: { switchedToGoogleAt: undefined } });
    const [item] = (await planByAge(t, Date.now() + HOUR)).items;
    expect(item.eligible).toBe(false);
    expect(item.reason).toContain('Clean it up by account');
    expect(item.connections[0].switchedToGoogleAt).toBeNull();
  });

  test('two switched users on one Nylas grant are eligible together', async () => {
    const t = newHarness();
    await seedNylasAccount(t);
    await seedNylasAccount(t, USER_B);
    await switchAccount(t);
    await switchAccount(t, USER_B, GRANT_B);
    const plan = await planByAge(t, Date.now() + HOUR);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].eligible).toBe(true);
    expect(plan.items[0].connections).toHaveLength(2);
  });

  test('a grant that more connections keep than one claim can hold stays', async () => {
    const t = newHarness();
    await t.run(async (ctx) => {
      const ts = Date.now();
      for (let index = 0; index < 21; index += 1) {
        const userId = `user_many_${index}`;
        const grantId = `google:00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
        await ctx.db.insert('connectedAccounts', {
          userId,
          accountId: ACCOUNT,
          email: 'ann@example.com',
          provider: 'google',
          status: 'connected',
          scopes: ['openid'],
          grantId,
          createdAt: ts,
          updatedAt: ts,
        } as any);
        await ctx.db.insert('providerGrants', {
          userId,
          accountId: ACCOUNT,
          provider: 'google',
          grantId,
          email: 'ann@example.com',
          scopes: ['openid'],
          previousNylasGrantId: NYLAS_GRANT,
          switchedToGoogleAt: ts - 10 * HOUR,
          createdAt: ts,
          updatedAt: ts,
        });
      }
    });
    const [item] = (await planByAge(t, Date.now())).items;
    expect(item).toMatchObject({
      eligible: false,
      reason: 'More than 20 connections keep this Nylas grant.',
    });
    expect(item.connections).toHaveLength(20);
    const claim = await t.mutation(api.googleDirect.claimNylasGrantCleanup, {
      internalSecret: SECRET,
      nylasGrantId: NYLAS_GRANT,
      switchedBefore: Date.now(),
    });
    expect(claim).toEqual({ claimed: false, reason: 'More than 20 connections keep this Nylas grant.' });
  });

  test('an account with nothing kept gives an empty plan', async () => {
    const t = newHarness();
    await seedNylasAccount(t);
    expect(await planByAge(t, Date.now())).toEqual({ items: [], truncated: false });
  });
});

const claimArgs = (overrides: Record<string, unknown> = {}) => ({
  internalSecret: SECRET,
  nylasGrantId: NYLAS_GRANT,
  userId: USER,
  accountId: ACCOUNT,
  ...overrides,
});

const finish = (t: Harness, deleted: boolean, holders = [{ userId: USER, accountId: ACCOUNT }]) =>
  t.mutation(api.googleDirect.finishNylasGrantCleanup, {
    internalSecret: SECRET,
    nylasGrantId: NYLAS_GRANT,
    holders,
    deleted,
  });

describe('claim and finish', () => {
  test('a claim holds the grant: no rollback, no webhook owner, and a finish records the delete', async () => {
    const t = newHarness();
    await seedNylasAccount(t);
    await switchAccount(t);
    const claim = await t.mutation(api.googleDirect.claimNylasGrantCleanup, claimArgs());
    expect(claim).toEqual({ claimed: true, holders: [{ userId: USER, accountId: ACCOUNT }] });
    const held = await grantRow(t);
    expect(held?.previousNylasGrantId).toBeUndefined();
    expect(held?.nylasGrantDeletePending).toBe(NYLAS_GRANT);

    // While the claim holds, the rollback cannot put the account on the grant.
    expect(
      await t.mutation(internal.googleDirect.rollbackToNylas, { userId: USER, accountId: ACCOUNT }),
    ).toEqual({
      ok: false,
      reason: 'The Nylas grant cleanup holds the Nylas grant and can delete it now.',
    });
    // A second run does not claim it again.
    expect((await t.mutation(api.googleDirect.claimNylasGrantCleanup, claimArgs())).claimed).toBe(false);
    expect((await planForAccount(t)).items[0].reason).toContain('A cleanup run holds this Nylas grant');

    const before = Date.now();
    expect(await finish(t, true)).toEqual({ updated: 1 });
    const done = await grantRow(t);
    expect(done?.nylasGrantDeletePending).toBeUndefined();
    expect(done?.previousNylasGrantId).toBeUndefined();
    expect(done?.nylasGrantRevokedAt).toBeGreaterThanOrEqual(before);
    expect(
      await t.mutation(internal.googleDirect.rollbackToNylas, { userId: USER, accountId: ACCOUNT }),
    ).toEqual({
      ok: false,
      reason: 'The Nylas grant cleanup deleted the Nylas grant. Connect the account through Nylas again.',
    });
    expect(
      await t.query(api.googleDirect.accountForPreviousNylasGrant, {
        internalSecret: SECRET,
        grantId: NYLAS_GRANT,
      }),
    ).toBeNull();
    // A disconnect has no Nylas grant left to destroy.
    const removed = await t.mutation(api.googleDirect.removeGrant, {
      internalSecret: SECRET,
      grantId: GRANT,
    });
    expect(removed.previousNylasGrantIds).toEqual([]);
  });

  test('a failed delete gives the grant back, and the rollback works again', async () => {
    const t = newHarness();
    await seedNylasAccount(t);
    await switchAccount(t);
    await t.mutation(api.googleDirect.claimNylasGrantCleanup, claimArgs());
    expect(await finish(t, false)).toEqual({ updated: 1 });
    const row = await grantRow(t);
    expect(row?.previousNylasGrantId).toBe(NYLAS_GRANT);
    expect(row?.nylasGrantDeletePending).toBeUndefined();
    expect(row?.nylasGrantRevokedAt).toBeUndefined();
    expect(
      (await t.mutation(internal.googleDirect.rollbackToNylas, { userId: USER, accountId: ACCOUNT })).ok,
    ).toBe(true);
  });

  test('a rollback after the plan and before the claim makes the claim refuse', async () => {
    const t = newHarness();
    await seedNylasAccount(t);
    await switchAccount(t);
    expect((await planForAccount(t)).items[0].eligible).toBe(true);
    await t.mutation(internal.googleDirect.rollbackToNylas, { userId: USER, accountId: ACCOUNT });
    const claim = await t.mutation(api.googleDirect.claimNylasGrantCleanup, claimArgs());
    expect(claim.claimed).toBe(false);
    // The account is on the Nylas grant again, so the claim must not take it.
    expect((await grantRow(t))?.grantId).toBe(NYLAS_GRANT);
  });

  test('an age claim holds every switched connection of the grant; a finish touches only the held rows', async () => {
    const t = newHarness();
    await seedNylasAccount(t);
    await seedNylasAccount(t, USER_B);
    await switchAccount(t);
    await switchAccount(t, USER_B, GRANT_B);
    const claim = await t.mutation(api.googleDirect.claimNylasGrantCleanup, {
      internalSecret: SECRET,
      nylasGrantId: NYLAS_GRANT,
      switchedBefore: Date.now() + HOUR,
    });
    expect(claim.claimed).toBe(true);
    if (!claim.claimed) throw new Error('Expected a claim');
    expect(claim.holders.map((holder) => holder.userId).sort()).toEqual([USER, USER_B]);

    // A finish for A only leaves B held; a finish for a row that the claim did not hold does nothing.
    expect(await finish(t, true)).toEqual({ updated: 1 });
    expect((await grantRow(t, USER_B))?.nylasGrantDeletePending).toBe(NYLAS_GRANT);
    expect(await finish(t, true, [{ userId: 'user_other', accountId: ACCOUNT }])).toEqual({ updated: 0 });
    expect(await finish(t, true, [{ userId: USER_B, accountId: ACCOUNT }])).toEqual({ updated: 1 });
    expect((await grantRow(t, USER_B))?.nylasGrantRevokedAt).toBeNumber();
    // A finish again changes nothing: the rows no longer hold the claim.
    expect(await finish(t, false, claim.holders)).toEqual({ updated: 0 });
  });

  test('the claim refuses what the plan refuses, and a grant that the account does not keep', async () => {
    const t = newHarness();
    await expect(t.mutation(api.googleDirect.claimNylasGrantCleanup, claimArgs())).resolves.toEqual({
      claimed: false,
      reason: 'The account was not found.',
    });
    await seedNylasAccount(t);
    await switchAccount(t);
    expect(
      await t.mutation(api.googleDirect.claimNylasGrantCleanup, claimArgs({ nylasGrantId: 'another-grant' })),
    ).toEqual({ claimed: false, reason: 'The account keeps another Nylas grant.' });
    expect(
      await t.mutation(api.googleDirect.claimNylasGrantCleanup, {
        internalSecret: SECRET,
        nylasGrantId: NYLAS_GRANT,
        switchedBefore: 0,
      }),
    ).toEqual({ claimed: false, reason: 'A connection switched too recently.' });
    expect(
      await t.mutation(api.googleDirect.claimNylasGrantCleanup, {
        internalSecret: SECRET,
        nylasGrantId: 'nobody-keeps-this',
        switchedBefore: Date.now() + HOUR,
      }),
    ).toEqual({ claimed: false, reason: 'No connection keeps this Nylas grant.' });
    expect((await grantRow(t))?.previousNylasGrantId).toBe(NYLAS_GRANT);
    await expect(
      t.mutation(api.googleDirect.claimNylasGrantCleanup, claimArgs({ internalSecret: 'wrong' })),
    ).rejects.toThrow('Invalid Convex internal secret.');
    await expect(
      t.mutation(api.googleDirect.finishNylasGrantCleanup, {
        internalSecret: 'wrong',
        nylasGrantId: NYLAS_GRANT,
        holders: [],
        deleted: true,
      }),
    ).rejects.toThrow('Invalid Convex internal secret.');
  });

  test('a new switch after a cleanup starts a new switch time and clears the old cleanup time', async () => {
    const t = newHarness();
    await seedNylasAccount(t);
    await switchAccount(t);
    await t.mutation(api.googleDirect.claimNylasGrantCleanup, claimArgs());
    await finish(t, true);
    // The user connects through Nylas again (a new Nylas grant), then switches again.
    await patchRows(t, USER, {
      account: { grantId: 'new-nylas-grant' },
      grant: { grantId: 'new-nylas-grant' },
    });
    await switchAccount(t, USER, GRANT_B);
    const row = await grantRow(t);
    expect(row?.previousNylasGrantId).toBe('new-nylas-grant');
    expect(row?.nylasGrantRevokedAt).toBeUndefined();
    expect(row?.switchedToGoogleAt).toBeNumber();
  });
});
