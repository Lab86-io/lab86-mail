import { afterAll, beforeAll, describe, expect, jest, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api, internal } from '../convex/_generated/api';
import { HELD_SEND_BATCH } from '../convex/mailOutbox';
import schema from '../convex/schema';

const convexModules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/cloudFiles.ts': () => import('../convex/cloudFiles'),
  '../convex/googleDirect.ts': () => import('../convex/googleDirect'),
  '../convex/mailOutbox.ts': () => import('../convex/mailOutbox'),
};

const SECRET = 'google-direct-runtime-secret';
const USER = 'user_google';
const NYLAS_GRANT = 'd502cbfc-98b3-49f4-93a7-d0a5d825d7fa';
const ACCOUNT = 'dc636c8d-1660-4cfb-b7ab-8c10811f98a8';
const GRANT = 'google:11111111-1111-4111-8111-111111111111';
const USER_B = 'user_google_b';
const GRANT_B = 'google:22222222-2222-4222-8222-222222222222';
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

/** A Google account on Nylas, with a ready corpus and calendar and contact sync rows. */
async function seedNylasAccount(
  t: ReturnType<typeof newHarness>,
  overrides: Record<string, unknown> = {},
  userId = USER,
) {
  await t.run(async (ctx) => {
    const ts = Date.now();
    await ctx.db.insert('connectedAccounts', {
      userId,
      accountId: ACCOUNT,
      email: 'ann@example.com',
      provider: 'google',
      status: 'error',
      error: 'Reconnect needed: the mailbox sign-in expired',
      errorSince: ts - 1000,
      errorSinceSource: 'status_change',
      scopes: ['email'],
      grantId: NYLAS_GRANT,
      displayName: 'Ann',
      createdAt: ts,
      updatedAt: ts,
      ...overrides,
    } as any);
    await ctx.db.insert('providerGrants', {
      userId,
      accountId: ACCOUNT,
      provider: 'google',
      grantId: NYLAS_GRANT,
      email: 'ann@example.com',
      accessTokenEncrypted: 'nylas-access',
      scopes: ['email'],
      createdAt: ts,
      updatedAt: ts,
    });
    await ctx.db.insert('mailSyncStates', {
      userId,
      accountId: ACCOUNT,
      grantId: NYLAS_GRANT,
      provider: 'google',
      status: 'error',
      corpusReady: true,
      error: 'grant gone',
      cursor: 'keep-me',
      createdAt: ts,
      updatedAt: ts,
    });
    await ctx.db.insert('calendarSyncStates', {
      userId,
      accountId: ACCOUNT,
      grantId: NYLAS_GRANT,
      provider: 'google',
      status: 'ready',
      createdAt: ts,
      updatedAt: ts,
    });
    await ctx.db.insert('contactSyncStates', {
      userId,
      accountId: ACCOUNT,
      grantId: NYLAS_GRANT,
      provider: 'google',
      status: 'ready',
      createdAt: ts,
      updatedAt: ts,
    } as any);
  });
}

const activation = (overrides: Record<string, unknown> = {}) => ({
  internalSecret: SECRET,
  userId: USER,
  mode: 'switch' as const,
  accountId: ACCOUNT,
  newAccountId: 'new-account-id',
  newGrantId: GRANT,
  email: 'Ann@Example.com',
  displayName: 'Ann G',
  scopes: ['openid', 'https://www.googleapis.com/auth/gmail.modify'],
  accessTokenEncrypted: 'enc-access',
  refreshTokenEncrypted: 'enc-refresh',
  expiresAt: Date.now() + 3_600_000,
  historyId: '1000',
  ...overrides,
});

async function snapshot(t: ReturnType<typeof newHarness>) {
  return await t.run(async (ctx) => ({
    account: await ctx.db.query('connectedAccounts').first(),
    accounts: await ctx.db.query('connectedAccounts').collect(),
    grant: await ctx.db.query('providerGrants').first(),
    mail: await ctx.db.query('mailSyncStates').first(),
    calendar: await ctx.db.query('calendarSyncStates').first(),
    contacts: await ctx.db.query('contactSyncStates').first(),
  }));
}

describe('direct Google sign-in state', () => {
  test('a state is single use, expires, and needs the secret', async () => {
    const t = newHarness();
    const base = {
      internalSecret: SECRET,
      userId: USER,
      mode: 'switch' as const,
      accountId: ACCOUNT,
      redirectTo: '/settings',
      nativeCallback: false,
      codeVerifierEncrypted: 'enc-verifier',
    };
    await t.mutation(api.googleDirect.saveOAuthState, {
      ...base,
      state: 'fresh',
      expiresAt: Date.now() + 60_000,
    });
    await t.mutation(api.googleDirect.saveOAuthState, { ...base, state: 'old', expiresAt: Date.now() - 1 });
    expect(
      await t.mutation(api.googleDirect.consumeOAuthState, { internalSecret: SECRET, state: 'fresh' }),
    ).toEqual({
      userId: USER,
      mode: 'switch',
      accountId: ACCOUNT,
      redirectTo: '/settings',
      nativeCallback: false,
      codeVerifierEncrypted: 'enc-verifier',
    });
    expect(
      await t.mutation(api.googleDirect.consumeOAuthState, { internalSecret: SECRET, state: 'fresh' }),
    ).toBeNull();
    expect(
      await t.mutation(api.googleDirect.consumeOAuthState, { internalSecret: SECRET, state: 'old' }),
    ).toBeNull();
    expect(
      await t.mutation(api.googleDirect.consumeOAuthState, { internalSecret: SECRET, state: 'never' }),
    ).toBeNull();
    await expect(
      t.mutation(api.googleDirect.consumeOAuthState, { internalSecret: 'wrong', state: 'x' }),
    ).rejects.toThrow('Invalid Convex internal secret');
    await t.mutation(api.googleDirect.saveOAuthState, { ...base, state: 'swept', expiresAt: Date.now() - 1 });
    expect(await t.mutation(internal.googleDirect.sweepExpiredOAuthStates, {})).toEqual({ deleted: 1 });
  });
});

describe('switch, reconnect, and rollback', () => {
  test('a switch keeps the account and corpus, stores the tokens, and keeps the Nylas grant', async () => {
    const t = newHarness();
    await seedNylasAccount(t);
    const result = await t.mutation(api.googleDirect.activateGoogleAccount, activation());
    expect(result).toEqual({
      accountId: ACCOUNT,
      grantId: GRANT,
      outcome: 'switched',
      previousNylasGrantId: NYLAS_GRANT,
    });
    const after = await snapshot(t);
    expect(after.accounts).toHaveLength(1);
    expect(after.account).toMatchObject({
      accountId: ACCOUNT,
      grantId: GRANT,
      status: 'connected',
      email: 'ann@example.com',
      displayName: 'Ann',
      scopes: ['openid', 'https://www.googleapis.com/auth/gmail.modify'],
    });
    expect(after.account?.error).toBeUndefined();
    expect(after.account?.errorSince).toBeUndefined();
    expect(after.grant).toMatchObject({
      grantId: GRANT,
      refreshTokenEncrypted: 'enc-refresh',
      accessTokenEncrypted: 'enc-access',
      previousNylasGrantId: NYLAS_GRANT,
    });
    expect(after.mail).toMatchObject({
      grantId: GRANT,
      status: 'ready',
      corpusReady: true,
      cursor: 'keep-me',
      historyId: '1000',
    });
    expect(after.calendar?.grantId).toBe(GRANT);
    expect(after.contacts?.grantId).toBe(GRANT);

    expect(
      await t.query(api.googleDirect.accountForPreviousNylasGrant, {
        internalSecret: SECRET,
        grantId: NYLAS_GRANT,
      }),
    ).toEqual({ userId: USER, accountId: ACCOUNT, grantId: GRANT });
    expect(await t.query(internal.googleDirect.listDirectMailAccounts, {})).toEqual([
      { userId: USER, accountId: ACCOUNT },
    ]);
    const credentials = await t.query(api.googleDirect.getGrantCredentials, {
      internalSecret: SECRET,
      grantId: GRANT,
    });
    expect(credentials).toMatchObject({
      userId: USER,
      accountId: ACCOUNT,
      refreshTokenEncrypted: 'enc-refresh',
    });
    expect(
      await t.query(api.googleDirect.getGrantCredentials, { internalSecret: SECRET, grantId: NYLAS_GRANT }),
    ).toBeNull();
  });

  test('a reconnect keeps the first Nylas grant and the stored History point', async () => {
    const t = newHarness();
    await seedNylasAccount(t);
    await t.mutation(api.googleDirect.activateGoogleAccount, activation());
    await t.run(async (ctx) => {
      const account = await ctx.db.query('connectedAccounts').first();
      await ctx.db.patch(account!._id, {
        status: 'error',
        error: 'Reconnect needed: the mailbox sign-in expired',
      });
    });
    const result = await t.mutation(
      api.googleDirect.activateGoogleAccount,
      activation({
        mode: 'reconnect',
        historyId: '5000',
        refreshTokenEncrypted: 'enc-refresh-2',
        newGrantId: 'google:not-used',
      }),
    );
    expect(result.outcome).toBe('reconnected');
    // A reconnect keeps the grant id of the connection.
    expect(result.grantId).toBe(GRANT);
    expect(result.previousNylasGrantId).toBe(NYLAS_GRANT);
    const after = await snapshot(t);
    expect(after.account?.status).toBe('connected');
    expect(after.grant?.refreshTokenEncrypted).toBe('enc-refresh-2');
    expect(after.mail?.historyId).toBe('1000');
  });

  test('a switch refuses another email, another provider, and a missing account', async () => {
    const t = newHarness();
    await seedNylasAccount(t);
    await expect(
      t.mutation(api.googleDirect.activateGoogleAccount, activation({ email: 'other@example.com' })),
    ).rejects.toThrow('does not match');
    await expect(
      t.mutation(api.googleDirect.activateGoogleAccount, activation({ accountId: 'nope' })),
    ).rejects.toThrow('not found');
    const other = newHarness();
    await seedNylasAccount(other, { provider: 'microsoft' });
    await expect(other.mutation(api.googleDirect.activateGoogleAccount, activation())).rejects.toThrow(
      'Only a Google account',
    );
    expect((await snapshot(t)).account?.grantId).toBe(NYLAS_GRANT);
  });

  test('new matches an account by email, or creates one with a fresh sync state', async () => {
    const t = newHarness();
    await seedNylasAccount(t);
    const matched = await t.mutation(
      api.googleDirect.activateGoogleAccount,
      activation({ mode: 'new', accountId: undefined }),
    );
    expect(matched.outcome).toBe('switched');
    expect(matched.accountId).toBe(ACCOUNT);
    const created = await t.mutation(
      api.googleDirect.activateGoogleAccount,
      activation({
        mode: 'new',
        accountId: undefined,
        email: 'second@example.com',
        newAccountId: 'acct-second',
        newGrantId: 'google:grant-second',
      }),
    );
    expect(created).toEqual({
      accountId: 'acct-second',
      grantId: 'google:grant-second',
      outcome: 'created',
      previousNylasGrantId: undefined,
    });
    const rows = await t.run(async (ctx) => ({
      account: await ctx.db
        .query('connectedAccounts')
        .withIndex('by_user_account', (q) => q.eq('userId', USER).eq('accountId', 'acct-second'))
        .unique(),
      mail: await ctx.db
        .query('mailSyncStates')
        .withIndex('by_user_account', (q) => q.eq('userId', USER).eq('accountId', 'acct-second'))
        .unique(),
    }));
    expect(rows.account).toMatchObject({
      grantId: 'google:grant-second',
      displayName: 'Ann G',
      status: 'connected',
    });
    expect(rows.mail).toMatchObject({ status: 'idle', corpusReady: false, historyId: '1000' });
  });

  test('rollback puts the Nylas grant back and deletes the Google tokens', async () => {
    const t = newHarness();
    await seedNylasAccount(t);
    await t.mutation(api.googleDirect.activateGoogleAccount, activation());
    const result = await t.mutation(internal.googleDirect.rollbackToNylas, {
      userId: USER,
      accountId: ACCOUNT,
    });
    expect(result).toEqual({ ok: true, grantId: NYLAS_GRANT });
    const after = await snapshot(t);
    expect(after.account).toMatchObject({ grantId: NYLAS_GRANT, status: 'connected' });
    expect(after.grant?.grantId).toBe(NYLAS_GRANT);
    expect(after.grant?.refreshTokenEncrypted).toBeUndefined();
    expect(after.grant?.previousNylasGrantId).toBeUndefined();
    expect(after.mail).toMatchObject({ grantId: NYLAS_GRANT, corpusReady: true });
    expect(after.mail?.historyId).toBeUndefined();
    expect(after.calendar?.grantId).toBe(NYLAS_GRANT);
    expect(await t.query(internal.googleDirect.listDirectMailAccounts, {})).toEqual([]);
    expect(
      await t.mutation(internal.googleDirect.rollbackToNylas, { userId: USER, accountId: ACCOUNT }),
    ).toEqual({
      ok: false,
      reason: 'The account uses Nylas.',
    });
    expect(
      await t.mutation(internal.googleDirect.rollbackToNylas, { userId: USER, accountId: 'nope' }),
    ).toEqual({
      ok: false,
      reason: 'The account was not found.',
    });
  });

  test('rollback needs a Nylas grant to go back to', async () => {
    const t = newHarness();
    await t.mutation(
      api.googleDirect.activateGoogleAccount,
      activation({ mode: 'new', accountId: undefined }),
    );
    const created = await snapshot(t);
    expect(
      await t.mutation(internal.googleDirect.rollbackToNylas, {
        userId: USER,
        accountId: created.account!.accountId,
      }),
    ).toEqual({ ok: false, reason: 'The account has no Nylas grant to go back to.' });
  });
});

describe('token row', () => {
  test('a refresh updates the token, and remove returns the Nylas grant to destroy', async () => {
    const t = newHarness();
    await seedNylasAccount(t);
    await t.mutation(api.googleDirect.activateGoogleAccount, activation());
    const grantId = GRANT;
    expect(
      await t.mutation(api.googleDirect.saveGrantAccessToken, {
        internalSecret: SECRET,
        userId: USER,
        accountId: ACCOUNT,
        grantId,
        accessTokenEncrypted: 'enc-access-2',
        expiresAt: 42,
        refreshTokenEncrypted: 'enc-refresh-rotated',
      }),
    ).toEqual({ updated: 1 });
    expect((await snapshot(t)).grant).toMatchObject({
      accessTokenEncrypted: 'enc-access-2',
      expiresAt: 42,
      refreshTokenEncrypted: 'enc-refresh-rotated',
    });
    expect(
      await t.mutation(api.googleDirect.saveGrantAccessToken, {
        internalSecret: SECRET,
        userId: USER,
        accountId: ACCOUNT,
        grantId: NYLAS_GRANT,
        accessTokenEncrypted: 'x',
        expiresAt: 1,
      }),
    ).toEqual({ updated: 0 });
    expect(
      await t.mutation(api.googleDirect.removeGrant, { internalSecret: SECRET, grantId: NYLAS_GRANT }),
    ).toEqual({
      removed: 0,
      previousNylasGrantIds: [],
      cancelledSends: 0,
    });
    // A held scheduled send of this mailbox goes with the grant; others stay.
    const payloadId = await t.run(async (ctx) => ctx.storage.store(new Blob(['{"to":"x"}'])));
    const otherPayload = await t.run(async (ctx) => ctx.storage.store(new Blob(['{}'])));
    const heldKey = 'outbox:00000000-0000-4000-8000-00000000000a';
    const otherKey = 'outbox:00000000-0000-4000-8000-00000000000b';
    const fireAt = Date.now() + 3_600_000;
    await t.mutation(api.googleDirect.enqueueScheduledSend, {
      internalSecret: SECRET,
      userId: USER,
      accountId: ACCOUNT,
      key: heldKey,
      payloadId,
      fireAt,
    });
    await t.mutation(api.googleDirect.enqueueScheduledSend, {
      internalSecret: SECRET,
      userId: USER,
      accountId: 'another-account',
      key: otherKey,
      payloadId: otherPayload,
      fireAt,
    });
    expect(await t.mutation(api.googleDirect.removeGrant, { internalSecret: SECRET, grantId })).toEqual({
      removed: 1,
      previousNylasGrantIds: [NYLAS_GRANT],
      cancelledSends: 1,
    });
    const held = await t.query(api.googleDirect.getScheduledSend, {
      internalSecret: SECRET,
      userId: USER,
      key: heldKey,
    });
    expect(held?.status).toBe('cancelled');
    expect(await t.run(async (ctx) => ctx.storage.get(payloadId))).toBeNull();
    const other = await t.query(api.googleDirect.getScheduledSend, {
      internalSecret: SECRET,
      userId: USER,
      key: otherKey,
    });
    expect(other?.status).toBe('pending');
    expect((await snapshot(t)).grant).toBeNull();
    expect(
      await t.query(api.googleDirect.accountForPreviousNylasGrant, {
        internalSecret: SECRET,
        grantId: NYLAS_GRANT,
      }),
    ).toBeNull();
  });
});

describe('held sends on grant removal', () => {
  test('a grant removal with more held sends than one pass cancels all of them', async () => {
    jest.useFakeTimers();
    try {
      const t = newHarness();
      await seedNylasAccount(t);
      await t.mutation(api.googleDirect.activateGoogleAccount, activation());
      const total = HELD_SEND_BATCH + 12;
      const seeded = await t.run(async (ctx) => {
        const hold = async (key: string, accountId: string) => {
          const payloadId = await ctx.storage.store(new Blob([key]));
          const id = await ctx.db.insert('mailOutbox', {
            userId: USER,
            key,
            accountId,
            scheduled: true,
            payloadId,
            status: 'pending',
            fireAt: Date.now() + 3_600_000,
            undoSeconds: 0,
            updatedAt: Date.now(),
          });
          return { id, payloadId };
        };
        const held = [];
        for (let i = 0; i < total; i++) held.push(await hold(`held-${i}`, ACCOUNT));
        return { held, other: await hold('other-mailbox', 'another-account') };
      });
      expect(
        await t.mutation(api.googleDirect.removeGrant, { internalSecret: SECRET, grantId: GRANT }),
      ).toEqual({ removed: 1, previousNylasGrantIds: [NYLAS_GRANT], cancelledSends: HELD_SEND_BATCH });
      await t.finishAllScheduledFunctions(() => jest.runAllTimers());
      const state = await t.run(async (ctx) => {
        const read = async (row: { id: any; payloadId: any }) => {
          const doc = await ctx.db.get(row.id);
          return `${(doc as any)?.status}:${Boolean((doc as any)?.payloadId)}:${(await ctx.storage.get(row.payloadId)) !== null}`;
        };
        return { held: await Promise.all(seeded.held.map(read)), other: await read(seeded.other) };
      });
      expect([...new Set(state.held)]).toEqual(['cancelled:false:false']);
      expect(state.other).toBe('pending:true:true');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('two users who share one accountId', () => {
  // One mailbox connected under two users: Nylas gives both the same grant id,
  // and the first grant id is the accountId of each account row.
  async function seedBoth(t: ReturnType<typeof newHarness>) {
    await seedNylasAccount(t);
    await seedNylasAccount(t, {}, USER_B);
    await t.mutation(api.googleDirect.activateGoogleAccount, activation());
    await t.mutation(
      api.googleDirect.activateGoogleAccount,
      activation({ userId: USER_B, newGrantId: GRANT_B, refreshTokenEncrypted: 'enc-refresh-b' }),
    );
  }

  async function holdSend(t: ReturnType<typeof newHarness>, userId: string, key: string) {
    const payloadId = await t.run(async (ctx) => ctx.storage.store(new Blob(['{}'])));
    await t.mutation(api.googleDirect.enqueueScheduledSend, {
      internalSecret: SECRET,
      userId,
      accountId: ACCOUNT,
      key,
      payloadId,
      fireAt: Date.now() + 3_600_000,
    });
  }

  test('each user gets a direct grant id of their own and only their own tokens', async () => {
    const t = newHarness();
    await seedBoth(t);
    const a = await t.query(api.googleDirect.getGrantCredentials, { internalSecret: SECRET, grantId: GRANT });
    const b = await t.query(api.googleDirect.getGrantCredentials, {
      internalSecret: SECRET,
      grantId: GRANT_B,
    });
    expect(a).toMatchObject({ userId: USER, accountId: ACCOUNT, refreshTokenEncrypted: 'enc-refresh' });
    expect(b).toMatchObject({ userId: USER_B, accountId: ACCOUNT, refreshTokenEncrypted: 'enc-refresh-b' });
    // A token refresh of A writes A's row only.
    expect(
      await t.mutation(api.googleDirect.saveGrantAccessToken, {
        internalSecret: SECRET,
        userId: USER,
        accountId: ACCOUNT,
        grantId: GRANT,
        accessTokenEncrypted: 'enc-access-a2',
        expiresAt: 1,
      }),
    ).toEqual({ updated: 1 });
    expect(
      await t.mutation(api.googleDirect.saveGrantAccessToken, {
        internalSecret: SECRET,
        userId: USER_B,
        accountId: ACCOUNT,
        grantId: GRANT,
        accessTokenEncrypted: 'enc-wrong',
        expiresAt: 1,
      }),
    ).toEqual({ updated: 0 });
    const bAfter = await t.query(api.googleDirect.getGrantCredentials, {
      internalSecret: SECRET,
      grantId: GRANT_B,
    });
    expect(bAfter?.accessTokenEncrypted).toBe('enc-access');
    expect(await t.query(internal.googleDirect.listDirectMailAccounts, {})).toHaveLength(2);
  });

  test("A's disconnect does not touch B's token, held sends, account, or shared Nylas grant", async () => {
    const t = newHarness();
    await seedBoth(t);
    const keyA = 'outbox:00000000-0000-4000-8000-0000000000a1';
    const keyB = 'outbox:00000000-0000-4000-8000-0000000000b1';
    await holdSend(t, USER, keyA);
    await holdSend(t, USER_B, keyB);
    expect(
      await t.mutation(api.googleDirect.removeGrant, { internalSecret: SECRET, grantId: GRANT }),
    ).toEqual({
      removed: 1,
      // B's connection still keeps this Nylas grant for its rollback.
      previousNylasGrantIds: [],
      cancelledSends: 1,
    });
    const b = await t.query(api.googleDirect.getGrantCredentials, {
      internalSecret: SECRET,
      grantId: GRANT_B,
    });
    expect(b).toMatchObject({ userId: USER_B, refreshTokenEncrypted: 'enc-refresh-b' });
    expect(
      (
        await t.query(api.googleDirect.getScheduledSend, {
          internalSecret: SECRET,
          userId: USER_B,
          key: keyB,
        })
      )?.status,
    ).toBe('pending');
    expect(
      (await t.query(api.googleDirect.getScheduledSend, { internalSecret: SECRET, userId: USER, key: keyA }))
        ?.status,
    ).toBe('cancelled');
    const bAccount = await t.run(async (ctx) =>
      ctx.db
        .query('connectedAccounts')
        .withIndex('by_user_account', (q) => q.eq('userId', USER_B).eq('accountId', ACCOUNT))
        .unique(),
    );
    expect(bAccount).toMatchObject({ grantId: GRANT_B, status: 'connected' });
    // When the last connection leaves, the Nylas grant can go.
    expect(
      await t.mutation(api.googleDirect.removeGrant, { internalSecret: SECRET, grantId: GRANT_B }),
    ).toEqual({
      removed: 1,
      previousNylasGrantIds: [NYLAS_GRANT],
      cancelledSends: 1,
    });
  });

  test('a Nylas grant that another user still uses on Nylas is not destroyed', async () => {
    const t = newHarness();
    await seedNylasAccount(t);
    await seedNylasAccount(t, { status: 'connected' }, USER_B);
    await t.mutation(api.googleDirect.activateGoogleAccount, activation());
    expect(
      await t.mutation(api.googleDirect.removeGrant, { internalSecret: SECRET, grantId: GRANT }),
    ).toEqual({
      removed: 1,
      previousNylasGrantIds: [],
      cancelledSends: 0,
    });
  });

  test('a direct grant id that another connection holds is refused', async () => {
    const t = newHarness();
    await seedNylasAccount(t);
    await seedNylasAccount(t, {}, USER_B);
    await t.mutation(api.googleDirect.activateGoogleAccount, activation());
    await expect(
      t.mutation(api.googleDirect.activateGoogleAccount, activation({ userId: USER_B, newGrantId: GRANT })),
    ).rejects.toThrow('share one direct Google grant id');
    await expect(
      t.mutation(
        api.googleDirect.activateGoogleAccount,
        activation({ newGrantId: 'nylas-looking-id', mode: 'new' }),
      ),
    ).resolves.toMatchObject({ grantId: GRANT });
    const fresh = newHarness();
    await expect(
      fresh.mutation(
        api.googleDirect.activateGoogleAccount,
        activation({ mode: 'new', accountId: undefined, newGrantId: 'not-direct' }),
      ),
    ).rejects.toThrow('direct Google grant id is required');
  });

  test('two token rows with one direct grant id are refused, not read or deleted', async () => {
    const t = newHarness();
    await seedBoth(t);
    await t.run(async (ctx) => {
      const rowB = await ctx.db
        .query('providerGrants')
        .withIndex('by_user_account', (q) => q.eq('userId', USER_B).eq('accountId', ACCOUNT))
        .unique();
      await ctx.db.patch(rowB!._id, { grantId: GRANT });
    });
    await expect(
      t.query(api.googleDirect.getGrantCredentials, { internalSecret: SECRET, grantId: GRANT }),
    ).rejects.toThrow('share one direct Google grant id');
    await expect(
      t.mutation(api.googleDirect.removeGrant, { internalSecret: SECRET, grantId: GRANT }),
    ).rejects.toThrow('share one direct Google grant id');
    // A token row whose account row names another grant is not returned.
    expect(
      await t.query(api.googleDirect.getGrantCredentials, { internalSecret: SECRET, grantId: GRANT_B }),
    ).toBeNull();
  });
});

describe('History id', () => {
  test('moves only forward, compares as numbers, and stops when the grant changed', async () => {
    const t = newHarness();
    await seedNylasAccount(t);
    await t.mutation(api.googleDirect.activateGoogleAccount, activation({ historyId: '1000' }));
    const advance = (historyId: string, grantId = GRANT) =>
      t.mutation(api.googleDirect.advanceHistoryId, {
        internalSecret: SECRET,
        userId: USER,
        accountId: ACCOUNT,
        grantId,
        historyId,
        progress: { stage: 'google_history' },
      });
    // '999' is after '1000' as text, but not as a number.
    expect(await advance('999')).toEqual({ saved: false, reason: 'not_newer', historyId: '1000' });
    expect(await advance('1000')).toMatchObject({ saved: false, reason: 'not_newer' });
    expect(await advance('1001')).toEqual({ saved: true, historyId: '1001' });
    expect(await advance('2000', NYLAS_GRANT)).toEqual({ saved: false, reason: 'grant_changed' });
    await expect(advance('12a')).rejects.toThrow('decimal number');
    const state = await t.run(async (ctx) => ctx.db.query('mailSyncStates').first());
    expect(state).toMatchObject({ historyId: '1001', progress: { stage: 'google_history' } });
    expect(state?.lastIncrementalSyncAt).toBeGreaterThan(0);
  });

  test('a connection with no stored id takes the first one', async () => {
    const t = newHarness();
    await seedNylasAccount(t);
    await t.mutation(api.googleDirect.activateGoogleAccount, activation());
    await t.run(async (ctx) => {
      const state = await ctx.db.query('mailSyncStates').first();
      await ctx.db.patch(state!._id, { historyId: undefined });
    });
    expect(
      await t.mutation(api.googleDirect.advanceHistoryId, {
        internalSecret: SECRET,
        userId: USER,
        accountId: ACCOUNT,
        grantId: GRANT,
        historyId: '5',
      }),
    ).toEqual({ saved: true, historyId: '5' });
  });
});

describe('scheduled sends', () => {
  test('a scheduled send is an outbox row with its account and fire time', async () => {
    const t = newHarness();
    const payloadId = await t.run(async (ctx) => ctx.storage.store(new Blob(['{}'])));
    const key = 'outbox:00000000-0000-4000-8000-000000000001';
    const fireAt = Date.now() + 3_600_000;
    const receipt = await t.mutation(api.googleDirect.enqueueScheduledSend, {
      internalSecret: SECRET,
      userId: USER,
      accountId: ACCOUNT,
      key,
      payloadId,
      fireAt,
    });
    expect(receipt).toEqual({ key, fireAt, status: 'pending' });
    const listed = await t.query(api.googleDirect.listScheduledSends, {
      internalSecret: SECRET,
      userId: USER,
      accountId: ACCOUNT,
    });
    expect(listed).toEqual([{ key, accountId: ACCOUNT, fireAt, status: 'pending', messageId: undefined }]);
    expect(
      await t.query(api.googleDirect.listScheduledSends, {
        internalSecret: SECRET,
        userId: USER,
        accountId: 'other',
      }),
    ).toEqual([]);
    expect(
      (await t.query(api.googleDirect.getScheduledSend, { internalSecret: SECRET, userId: USER, key }))
        ?.status,
    ).toBe('pending');
    // The outbox claim does not release it before the fire time.
    expect(await t.mutation(api.mailOutbox.claim, { internalSecret: SECRET, userId: USER, key })).toBeNull();
    expect(await t.mutation(api.mailOutbox.cancel, { internalSecret: SECRET, userId: USER, key })).toBe(true);
    expect(
      (await t.query(api.googleDirect.getScheduledSend, { internalSecret: SECRET, userId: USER, key }))
        ?.status,
    ).toBe('cancelled');
  });

  test('bad keys, far times, and undo rows are refused or hidden', async () => {
    const t = newHarness();
    const payloadId = await t.run(async (ctx) => ctx.storage.store(new Blob(['{}'])));
    const base = { internalSecret: SECRET, userId: USER, accountId: ACCOUNT, payloadId };
    await expect(
      t.mutation(api.googleDirect.enqueueScheduledSend, { ...base, key: 'bad', fireAt: Date.now() }),
    ).rejects.toThrow('Invalid send key');
    await expect(
      t.mutation(api.googleDirect.enqueueScheduledSend, {
        ...base,
        key: 'outbox:00000000-0000-4000-8000-000000000002',
        fireAt: Date.now() + 40 * 86_400_000,
      }),
    ).rejects.toThrow('too far');
    const undoKey = 'outbox:00000000-0000-4000-8000-000000000003';
    await t.mutation(api.mailOutbox.enqueue, {
      internalSecret: SECRET,
      userId: USER,
      key: undoKey,
      payloadId,
      undoSeconds: 5,
    });
    expect(
      await t.query(api.googleDirect.getScheduledSend, {
        internalSecret: SECRET,
        userId: USER,
        key: undoKey,
      }),
    ).toBeNull();
  });
});

describe('History cron', () => {
  test('the tick does nothing without the app URL and secret', async () => {
    const t = newHarness();
    const savedUrl = process.env.LAB86_MAIL_PUBLIC_URL;
    delete process.env.LAB86_MAIL_PUBLIC_URL;
    try {
      expect(await t.action(internal.googleDirect.historyTick, {})).toEqual({ requested: 0, ok: 0 });
    } finally {
      if (savedUrl !== undefined) process.env.LAB86_MAIL_PUBLIC_URL = savedUrl;
    }
  });

  test('the tick posts one request for each connected direct account', async () => {
    const t = newHarness();
    await seedNylasAccount(t);
    await t.mutation(api.googleDirect.activateGoogleAccount, activation());
    const savedUrl = process.env.LAB86_MAIL_PUBLIC_URL;
    const originalFetch = globalThis.fetch;
    const posts: any[] = [];
    process.env.LAB86_MAIL_PUBLIC_URL = 'https://mail.example/';
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      posts.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response('{}', { status: 202 });
    }) as typeof fetch;
    try {
      expect(await t.action(internal.googleDirect.historyTick, {})).toEqual({ requested: 1, ok: 1 });
      expect(posts).toEqual([
        { url: 'https://mail.example/api/cron/google-history', body: { userId: USER, accountId: ACCOUNT } },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      if (savedUrl === undefined) delete process.env.LAB86_MAIL_PUBLIC_URL;
      else process.env.LAB86_MAIL_PUBLIC_URL = savedUrl;
    }
  });
});

describe('googleAccessUsesAddress', () => {
  const ask = (t: ReturnType<typeof newHarness>, args: Record<string, string>) =>
    t.query(api.googleDirect.googleAccessUsesAddress, {
      internalSecret: SECRET,
      email: 'ann@example.com',
      ...args,
    });

  async function seedDrive(t: ReturnType<typeof newHarness>, connectionId: string, overrides = {}) {
    await t.run((ctx) =>
      ctx.db.insert('cloudFileConnections', {
        userId: USER_B,
        connectionId,
        provider: 'google_drive',
        accountKey: 'ann',
        accountEmail: 'ann@example.com',
        status: 'connected',
        scopes: [],
        createdAt: 1,
        updatedAt: 1,
        ...overrides,
      }),
    );
  }

  test('finds a Nylas Google grant of any user for the address, in either letter case', async () => {
    const t = newHarness();
    await seedNylasAccount(t, { status: 'connected', email: 'Ann@Example.com' }, USER_B);
    expect(await ask(t, { email: 'Ann@Example.com' })).toBe(true);
    expect(await ask(t, { email: 'other@example.com' })).toBe(false);
    expect(await ask(t, { email: '  ' })).toBe(false);
  });

  test('a lower-case stored address matches a mixed-case question', async () => {
    const t = newHarness();
    await seedNylasAccount(t, { status: 'connected' });
    expect(await ask(t, { email: 'Ann@Example.com' })).toBe(true);
  });

  test('a direct account of another user counts; the grant that goes, a disconnected row, and another provider do not', async () => {
    const t = newHarness();
    await seedNylasAccount(t, { status: 'disconnected' });
    await seedNylasAccount(t, { status: 'connected', provider: 'microsoft' }, 'user_c');
    await seedNylasAccount(t, { status: 'connected', grantId: 'google:direct-a' }, USER);
    expect(await ask(t, { exceptGrantId: 'google:direct-a' })).toBe(false);
    // Another user connected the same Google address directly: a revoke would end that grant.
    await seedNylasAccount(t, { status: 'error', grantId: GRANT_B }, USER_B);
    expect(await ask(t, { exceptGrantId: 'google:direct-a' })).toBe(true);
    expect(await ask(t, { exceptGrantId: GRANT_B })).toBe(true);
  });

  test('a Google Drive connection of any user counts, but not the one that goes', async () => {
    const t = newHarness();
    await seedDrive(t, 'drive-b');
    await seedDrive(t, 'onedrive-b', { provider: 'onedrive' });
    await seedDrive(t, 'drive-gone', { status: 'disconnected' });
    expect(await ask(t, {})).toBe(true);
    expect(await ask(t, { exceptConnectionId: 'drive-b' })).toBe(false);
    expect(await ask(t, { email: 'ANN@example.com', exceptConnectionId: 'drive-b' })).toBe(false);
  });

  test('a Drive connection saved with a mixed-case address counts for the disconnect of another one', async () => {
    const t = newHarness();
    const save = (userId: string, connectionId: string, accountEmail: string) =>
      t.mutation(api.cloudFiles.upsertConnection, {
        internalSecret: SECRET,
        userId,
        connectionId,
        provider: 'google_drive',
        accountKey: `key-${connectionId}`,
        accountEmail,
        scopes: [],
        accessTokenEncrypted: 'enc',
      });
    await save(USER, 'drive-a', ' Ann@Example.COM ');
    await save(USER_B, 'drive-b', 'ann@example.com');
    // The disconnect of B asks with the address of B. A has the same address.
    expect(await ask(t, { email: 'ann@example.com', exceptConnectionId: 'drive-b' })).toBe(true);
    expect(await ask(t, { email: 'ann@example.com', exceptConnectionId: 'drive-a' })).toBe(true);
  });
});
