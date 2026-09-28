import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { convexTest, type TestConvex } from 'convex-test';
import { api, internal } from '../convex/_generated/api';
import { isSavedContactEmail } from '../convex/contacts';
import schema from '../convex/schema';
import {
  CONTACT_FULL_SYNC_INTERVAL_MS,
  type ContactInput,
  DEAD_ACCOUNT_CONTACT_RETENTION_MS,
  normalizeNylasContact,
} from '../lib/contacts/model';

const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/accounts.ts': () => import('../convex/accounts'),
  '../convex/contacts.ts': () => import('../convex/contacts'),
};

const SECRET = 'contacts-secret';
let previousSecret: string | undefined;
beforeAll(() => {
  previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
});

const USER = 'user_contacts';
const ACCOUNT = 'grant_contacts';

function contact(id: string, fields: Record<string, unknown>, source = 'address_book'): ContactInput {
  const normalized = normalizeNylasContact({ id, ...fields }, source as any);
  if (!normalized) throw new Error('fixture has no email');
  return normalized;
}

async function connect(
  t: TestConvex<typeof schema>,
  userId = USER,
  grantId = ACCOUNT,
  email = 'me@acme.com',
) {
  await t.mutation(api.accounts.upsertConnectedAccount, {
    internalSecret: SECRET,
    userId,
    email,
    provider: 'google',
    grantId,
    scopes: ['openid'],
  });
}

async function upsert(t: TestConvex<typeof schema>, contacts: ContactInput[], accountId = ACCOUNT) {
  return await t.mutation(api.contacts.upsertContactBatch, {
    internalSecret: SECRET,
    userId: USER,
    accountId,
    provider: 'google',
    contacts,
  });
}

describe('contact rows', () => {
  test('insert, hash skip, update, and delete keep the address rows in step', async () => {
    const t = convexTest(schema, modules);
    await connect(t);
    const ann = contact('c1', { displayName: 'Ann Lee', emails: [{ email: 'ann@acme.com' }] });
    expect(await upsert(t, [ann])).toEqual({ inserted: 1, updated: 0, unchanged: 0 });
    expect(await upsert(t, [ann])).toEqual({ inserted: 0, updated: 0, unchanged: 1 });

    const moved = contact('c1', {
      displayName: 'Ann Lee',
      emails: [{ email: 'ann@newco.com' }, { email: 'ann@home.example' }],
    });
    expect(await upsert(t, [moved])).toEqual({ inserted: 0, updated: 1, unchanged: 0 });
    let emails = await t.run((ctx) => ctx.db.query('contactEmails').collect());
    expect(emails.map((row) => row.email).sort()).toEqual(['ann@home.example', 'ann@newco.com']);
    expect(emails[0]).toMatchObject({ name: 'Ann Lee', source: 'address_book', weight: 3 });

    // The same provider id from another source moves the row.
    const asInbox = { ...moved, source: 'inbox' as const };
    expect(await upsert(t, [asInbox])).toEqual({ inserted: 0, updated: 1, unchanged: 0 });
    emails = await t.run((ctx) => ctx.db.query('contactEmails').collect());
    expect(emails.every((row) => row.source === 'inbox' && row.weight === 2)).toBe(true);

    expect(
      await t.mutation(api.contacts.deleteContacts, {
        internalSecret: SECRET,
        userId: USER,
        accountId: ACCOUNT,
        providerContactIds: ['c1', 'missing'],
      }),
    ).toEqual({ deleted: 1 });
    expect(await t.run((ctx) => ctx.db.query('contacts').collect())).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query('contactEmails').collect())).toHaveLength(0);
  });

  test('batches have a size limit and the secret is required', async () => {
    const t = convexTest(schema, modules);
    const many = Array.from({ length: 201 }, (_, i) =>
      contact(`c${i}`, { emails: [{ email: `p${i}@x.io` }] }),
    );
    await expect(upsert(t, many)).rejects.toThrow('At most 200');
    await expect(
      t.mutation(api.contacts.deleteContacts, {
        internalSecret: SECRET,
        userId: USER,
        accountId: ACCOUNT,
        providerContactIds: many.map((row) => row.providerContactId),
      }),
    ).rejects.toThrow('At most 200');
    await expect(
      t.query(api.contacts.listContactStates, { internalSecret: 'wrong', userId: USER }),
    ).rejects.toThrow('Invalid Convex internal secret');
  });

  test('stored ids page by source for the prune', async () => {
    const t = convexTest(schema, modules);
    await upsert(t, [
      contact('a1', { emails: [{ email: 'a1@x.io' }] }),
      contact('a2', { emails: [{ email: 'a2@x.io' }] }),
      contact('i1', { emails: [{ email: 'i1@x.io' }] }, 'inbox'),
    ]);
    const first = await t.query(api.contacts.listContactIds, {
      internalSecret: SECRET,
      userId: USER,
      accountId: ACCOUNT,
      source: 'address_book',
      numItems: 1,
    });
    expect(first.ids).toHaveLength(1);
    expect(first.isDone).toBe(false);
    const second = await t.query(api.contacts.listContactIds, {
      internalSecret: SECRET,
      userId: USER,
      accountId: ACCOUNT,
      source: 'address_book',
      cursor: first.continueCursor,
      numItems: 5,
    });
    expect([...first.ids, ...second.ids].sort()).toEqual(['a1', 'a2']);
    const inbox = await t.query(api.contacts.listContactIds, {
      internalSecret: SECRET,
      userId: USER,
      accountId: ACCOUNT,
      source: 'inbox',
    });
    expect(inbox.ids).toEqual(['i1']);
  });
});

describe('sync lease and state', () => {
  const claim = (t: TestConvex<typeof schema>, leaseId: string, extra: Record<string, unknown> = {}) =>
    t.mutation(api.contacts.claimContactSync, {
      internalSecret: SECRET,
      userId: USER,
      accountId: ACCOUNT,
      grantId: ACCOUNT,
      provider: 'google',
      leaseId,
      leaseMs: 60_000,
      minIntervalMs: CONTACT_FULL_SYNC_INTERVAL_MS,
      ...extra,
    });

  test('one worker holds the lease, a fresh pass waits, and a 429 wait holds', async () => {
    const t = convexTest(schema, modules);
    expect(await claim(t, 'lease-1')).toMatchObject({ claimed: true, previous: null });
    expect(await claim(t, 'lease-2')).toMatchObject({ claimed: false, reason: 'leased' });
    // A finish from a worker that lost the lease changes nothing.
    expect(
      await t.mutation(api.contacts.finishContactSync, {
        internalSecret: SECRET,
        userId: USER,
        accountId: ACCOUNT,
        leaseId: 'lease-2',
        status: 'ready',
        sources: [],
      }),
    ).toEqual({ ok: false });
    expect(
      await t.mutation(api.contacts.finishContactSync, {
        internalSecret: SECRET,
        userId: USER,
        accountId: ACCOUNT,
        leaseId: 'lease-1',
        status: 'needs_reconnect',
        sources: [
          { source: 'address_book', state: 'ok', count: 2, error: 'x'.repeat(400) },
          { source: 'inbox', state: 'missing_scope' },
        ],
        contactCount: 2,
        lastFullSyncAt: Date.now(),
        error: 'y'.repeat(400),
      }),
    ).toEqual({ ok: true });
    expect(await claim(t, 'lease-3')).toMatchObject({ claimed: false, reason: 'fresh' });
    const forced = await claim(t, 'lease-3', { force: true });
    expect(forced).toMatchObject({ claimed: true, previous: { status: 'needs_reconnect', contactCount: 2 } });
    await t.mutation(api.contacts.finishContactSync, {
      internalSecret: SECRET,
      userId: USER,
      accountId: ACCOUNT,
      leaseId: 'lease-3',
      status: 'ready',
      sources: [],
      retryAt: Date.now() + 60_000,
    });
    expect(await claim(t, 'lease-4', { minIntervalMs: 0 })).toMatchObject({
      claimed: false,
      reason: 'backoff',
    });

    const states = await t.query(api.contacts.listContactStates, { internalSecret: SECRET, userId: USER });
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ accountId: ACCOUNT, status: 'ready', syncing: false });
    const stored = await t.run((ctx) => ctx.db.query('contactSyncStates').first());
    expect(stored?.leaseId).toBeUndefined();
  });

  test('a webhook mark needs a state row', async () => {
    const t = convexTest(schema, modules);
    const mark = () =>
      t.mutation(api.contacts.markContactWebhook, {
        internalSecret: SECRET,
        userId: USER,
        accountId: ACCOUNT,
      });
    expect(await mark()).toEqual({ ok: false });
    await claim(t, 'lease-1');
    expect(await mark()).toEqual({ ok: true });
    expect((await t.run((ctx) => ctx.db.query('contactSyncStates').first()))?.lastWebhookAt).toBeNumber();
  });
});

describe('contact reads', () => {
  test('search finds names and address prefixes of connected mailboxes only', async () => {
    const t = convexTest(schema, modules);
    await connect(t);
    await connect(t, USER, 'grant_dead', 'old@acme.com');
    await t.mutation(api.accounts.markGrantReconnectNeeded, {
      internalSecret: SECRET,
      grantId: 'grant_dead',
      reason: 'Reconnect needed: expired',
    });
    await upsert(t, [
      contact('c1', { displayName: 'Ann Lee', companyName: 'Acme', emails: [{ email: 'ann@acme.com' }] }),
      contact('c2', { displayName: 'Bob Stone', emails: [{ email: 'bstone@shop.example' }] }, 'inbox'),
    ]);
    await upsert(
      t,
      [contact('c3', { displayName: 'Ann Dead', emails: [{ email: 'ann@dead.example' }] })],
      'grant_dead',
    );

    const byName = await t.query(api.contacts.searchContacts, {
      internalSecret: SECRET,
      userId: USER,
      query: 'ann',
    });
    expect(byName.contacts.map((row) => row.emails[0])).toEqual(['ann@acme.com']);
    expect(byName.contacts[0]).toMatchObject({ name: 'Ann Lee', company: 'Acme', source: 'address_book' });

    const byPrefix = await t.query(api.contacts.searchContacts, {
      internalSecret: SECRET,
      userId: USER,
      query: 'bsto',
    });
    expect(byPrefix.contacts.map((row) => row.name)).toEqual(['Bob Stone']);
    expect(
      (await t.query(api.contacts.searchContacts, { internalSecret: SECRET, userId: USER, query: '  ' }))
        .contacts,
    ).toEqual([]);
    expect(
      (await t.query(api.contacts.searchContacts, { internalSecret: SECRET, userId: 'nobody', query: 'ann' }))
        .contacts,
    ).toEqual([]);
  });

  test('names come from saved contacts and the directory, never from inbox guesses', async () => {
    const t = convexTest(schema, modules);
    await connect(t);
    await upsert(t, [
      contact('c1', { displayName: 'Ann Lee', emails: [{ email: 'ann@acme.com' }] }),
      contact('c2', { displayName: 'Guess Name', emails: [{ email: 'guess@shop.example' }] }, 'inbox'),
      contact('c3', { displayName: 'Dir Person', emails: [{ email: 'dir@acme.com' }] }, 'domain'),
      contact('c4', { displayName: 'Ann In Directory', emails: [{ email: 'ann@acme.com' }] }, 'domain'),
    ]);
    const { names } = await t.query(api.contacts.namesForEmails, {
      internalSecret: SECRET,
      userId: USER,
      emails: ['ANN@acme.com', 'guess@shop.example', 'dir@acme.com', 'nobody@x.io', 'not-an-email'],
    });
    expect(names).toEqual([
      { email: 'ann@acme.com', name: 'Ann Lee', source: 'address_book' },
      { email: 'dir@acme.com', name: 'Dir Person', source: 'domain' },
    ]);
    expect(
      (await t.query(api.contacts.namesForEmails, { internalSecret: SECRET, userId: USER, emails: [] }))
        .names,
    ).toEqual([]);
    expect(
      (
        await t.query(api.contacts.namesForEmails, {
          internalSecret: SECRET,
          userId: 'nobody',
          emails: ['a@b.co'],
        })
      ).names,
    ).toEqual([]);

    await t.run(async (ctx) => {
      expect(await isSavedContactEmail(ctx, USER, 'ann@acme.com')).toBe(true);
      expect(await isSavedContactEmail(ctx, USER, 'dir@acme.com')).toBe(false);
      expect(await isSavedContactEmail(ctx, USER, 'nobody@x.io')).toBe(false);
    });
  });

  test('recent correspondents leave out self, noise, and no-reply senders', async () => {
    const t = convexTest(schema, modules);
    await connect(t);
    const base = {
      userId: USER,
      accountId: ACCOUNT,
      grantId: ACCOUNT,
      provider: 'google' as const,
      subject: 's',
      snippet: '',
      labels: ['INBOX'],
      unread: false,
      yearMonth: '2026-09',
      createdAt: 1,
      updatedAt: 1,
    };
    await t.run(async (ctx) => {
      const rows = [
        { providerThreadId: 't1', fromAddress: 'Ann Lee <ann@acme.com>', lastDate: 3_000 },
        { providerThreadId: 't2', fromAddress: 'ann@acme.com', lastDate: 1_000 },
        { providerThreadId: 't3', fromAddress: 'Me <me@acme.com>', lastDate: 2_000 },
        {
          providerThreadId: 't4',
          fromAddress: 'Deals <deals@shop.example>',
          lastDate: 4_000,
          smartPrimary: 'noise',
        },
        { providerThreadId: 't5', fromAddress: 'noreply@service.example', lastDate: 5_000 },
        { providerThreadId: 't6', fromAddress: 'bob@x.io', lastDate: 6_000 },
      ];
      for (const row of rows) await ctx.db.insert('mailCorpusThreads', { ...base, ...row });
    });
    const { correspondents } = await t.query(api.contacts.recentCorrespondents, {
      internalSecret: SECRET,
      userId: USER,
    });
    expect(correspondents).toEqual([
      { email: 'bob@x.io', lastAt: 6_000, count: 1 },
      { email: 'ann@acme.com', name: 'Ann Lee', lastAt: 3_000, count: 2 },
    ]);
    expect(
      (await t.query(api.contacts.recentCorrespondents, { internalSecret: SECRET, userId: 'nobody' }))
        .correspondents,
    ).toEqual([]);
  });
});

describe('cron targets and cleanup', () => {
  test('due, fresh, leased, waiting, and dead mailboxes', async () => {
    const t = convexTest(schema, modules);
    const ts = 1_800_000_000_000;
    await connect(t, 'user_new', 'g_new', 'a@x.io');
    await connect(t, 'user_fresh', 'g_fresh', 'b@x.io');
    await connect(t, 'user_leased', 'g_leased', 'c@x.io');
    await connect(t, 'user_wait', 'g_wait', 'd@x.io');
    await connect(t, 'user_dead', 'g_dead', 'e@x.io');
    await connect(t, 'user_dead_recent', 'g_dead_recent', 'f@x.io');
    for (const grantId of ['g_dead', 'g_dead_recent']) {
      await t.mutation(api.accounts.markGrantReconnectNeeded, {
        internalSecret: SECRET,
        grantId,
        reason: 'r',
      });
    }
    await t.run(async (ctx) => {
      const state = (userId: string, accountId: string, fields: Record<string, unknown>) =>
        ctx.db.insert('contactSyncStates', {
          userId,
          accountId,
          grantId: accountId,
          provider: 'google',
          status: 'ready',
          createdAt: ts - DEAD_ACCOUNT_CONTACT_RETENTION_MS * 2,
          updatedAt: ts,
          ...fields,
        });
      await state('user_fresh', 'g_fresh', { lastFullSyncAt: ts - 60_000 });
      await state('user_leased', 'g_leased', { leaseId: 'l', leaseUntil: ts + 60_000 });
      await state('user_wait', 'g_wait', { retryAt: ts + 60_000 });
      await state('user_dead', 'g_dead', { lastFullSyncAt: ts - DEAD_ACCOUNT_CONTACT_RETENTION_MS - 1 });
      await state('user_dead_recent', 'g_dead_recent', { lastFullSyncAt: ts - 60_000 });
    });
    const targets = await t.query(internal.contacts.syncTargets, { now: ts });
    expect(targets.sort()).toEqual(['user_dead', 'user_new']);
  });

  test('retiring a dead mailbox drains its contacts; a live one stays', async () => {
    const t = convexTest(schema, modules);
    await connect(t);
    await upsert(t, [contact('c1', { emails: [{ email: 'ann@acme.com' }] })]);
    expect(
      await t.mutation(api.contacts.retireAccountContacts, {
        internalSecret: SECRET,
        userId: USER,
        accountId: ACCOUNT,
      }),
    ).toEqual({ retired: false });
    await t.mutation(api.accounts.markGrantReconnectNeeded, {
      internalSecret: SECRET,
      grantId: ACCOUNT,
      reason: 'r',
    });
    await t.run((ctx) =>
      ctx.db.insert('contactSyncStates', {
        userId: USER,
        accountId: ACCOUNT,
        grantId: ACCOUNT,
        provider: 'google',
        status: 'ready',
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    expect(
      await t.mutation(api.contacts.retireAccountContacts, {
        internalSecret: SECRET,
        userId: USER,
        accountId: ACCOUNT,
      }),
    ).toEqual({ retired: true });
    expect(
      await t.mutation(internal.contacts.purgeContactsBatch, { userId: USER, accountId: ACCOUNT }),
    ).toEqual({ deleted: 2, done: true });
    for (const table of ['contacts', 'contactEmails', 'contactSyncStates'] as const) {
      expect(await t.run((ctx) => ctx.db.query(table).collect()), table).toHaveLength(0);
    }
  });

  test('account removal and user deletion take contacts, addresses, and state', async () => {
    const t = convexTest(schema, modules);
    await connect(t);
    await upsert(t, [
      contact('c1', { emails: [{ email: 'ann@acme.com' }, { email: 'ann@home.example' }] }),
      contact('c2', { emails: [{ email: 'bob@acme.com' }] }, 'inbox'),
    ]);
    await t.mutation(api.contacts.claimContactSync, {
      internalSecret: SECRET,
      userId: USER,
      accountId: ACCOUNT,
      grantId: ACCOUNT,
      provider: 'google',
      leaseId: 'l',
      leaseMs: 1,
      minIntervalMs: 0,
    });
    await t.mutation(api.accounts.deleteConnectedAccount, {
      internalSecret: SECRET,
      userId: USER,
      accountId: ACCOUNT,
    });
    expect(await t.run((ctx) => ctx.db.query('contactSyncStates').collect())).toHaveLength(0);
    for (let pass = 0; pass < 5; pass++) {
      const { deleted } = await t.mutation(internal.accounts.purgeAccountDataBatch, {
        userId: USER,
        accountId: ACCOUNT,
      });
      if (!deleted) break;
    }
    expect(await t.run((ctx) => ctx.db.query('contacts').collect())).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query('contactEmails').collect())).toHaveLength(0);

    await connect(t);
    await upsert(t, [contact('c3', { emails: [{ email: 'cy@acme.com' }] })]);
    await t.mutation(api.accounts.deleteUserCascade, { internalSecret: SECRET, userId: USER });
    for (let pass = 0; pass < 5; pass++) {
      const { deleted } = await t.mutation(internal.accounts.purgeUserDataBatch, { userId: USER });
      if (!deleted) break;
    }
    expect(await t.run((ctx) => ctx.db.query('contacts').collect())).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query('contactEmails').collect())).toHaveLength(0);
  });

  test('grant scopes stay current for the account and its grant row', async () => {
    const t = convexTest(schema, modules);
    await connect(t);
    const scopes = ['openid', 'https://www.googleapis.com/auth/contacts.readonly', 'openid', ' '];
    expect(
      await t.mutation(api.accounts.updateGrantScopes, {
        internalSecret: SECRET,
        userId: USER,
        accountId: ACCOUNT,
        grantId: ACCOUNT,
        scopes,
      }),
    ).toEqual({ updated: 2 });
    const account = await t.run((ctx) => ctx.db.query('connectedAccounts').first());
    const grant = await t.run((ctx) => ctx.db.query('providerGrants').first());
    expect(account?.scopes).toEqual(['openid', 'https://www.googleapis.com/auth/contacts.readonly']);
    expect(grant?.scopes).toEqual(account?.scopes);
    // A stale grant id changes nothing.
    expect(
      await t.mutation(api.accounts.updateGrantScopes, {
        internalSecret: SECRET,
        userId: USER,
        accountId: ACCOUNT,
        grantId: 'old',
        scopes: [],
      }),
    ).toEqual({ updated: 0 });
  });
});
