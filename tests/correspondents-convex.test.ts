import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { convexTest, type TestConvex } from 'convex-test';
import { api, internal } from '../convex/_generated/api';
import { CORRESPONDENT_MIGRATION } from '../convex/correspondents';
import schema from '../convex/schema';
import { normalizeNylasContact } from '../lib/contacts/model';

const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/accounts.ts': () => import('../convex/accounts'),
  '../convex/contacts.ts': () => import('../convex/contacts'),
  '../convex/correspondents.ts': () => import('../convex/correspondents'),
  '../convex/mailCorpus.ts': () => import('../convex/mailCorpus'),
};

const SECRET = 'correspondents-secret';
let previousSecret: string | undefined;
beforeAll(() => {
  previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
});

const USER = 'user_people';
const NOW = Date.parse('2026-09-27T12:00:00Z');
const DAY = 86_400_000;

async function connect(t: TestConvex<typeof schema>, grantId: string, email: string, userId = USER) {
  await t.mutation(api.accounts.upsertConnectedAccount, {
    internalSecret: SECRET,
    userId,
    email,
    provider: 'google',
    grantId,
    scopes: [],
  });
}

function message(id: string, fields: Record<string, unknown>) {
  return {
    providerMessageId: id,
    providerThreadId: `t_${id}`,
    subject: 'Hello',
    from: 'Ann Lee <ann@acme.com>',
    to: 'me@lab86.io',
    receivedAt: NOW - DAY,
    snippet: '',
    searchText: 'hello',
    labels: ['INBOX'],
    ...fields,
  };
}

async function upsert(t: TestConvex<typeof schema>, messages: any[], accountId = 'grant_work') {
  return await t.mutation(api.mailCorpus.upsertCorpusBatch, {
    internalSecret: SECRET,
    userId: USER,
    accountId,
    grantId: accountId,
    provider: 'google',
    threads: [],
    messages,
  });
}

async function rows(t: TestConvex<typeof schema>) {
  const list = await t.run((ctx) => ctx.db.query('correspondents').collect());
  return Object.fromEntries(list.map((row) => [row.email, row]));
}

async function drain(t: TestConvex<typeof schema>) {
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    await t.finishInProgressScheduledFunctions();
  }
}

describe('index upkeep on ingest', () => {
  test('new mail counts once; sent mail counts its recipients; updates count nothing', async () => {
    const t = convexTest(schema, modules);
    await connect(t, 'grant_work', 'me@lab86.io');
    await upsert(t, [
      message('m1', {}),
      message('m2', {
        from: 'Me <me@lab86.io>',
        to: 'Ann Lee <ann@acme.com>, "Bo, Stone" <bo@acme.com>',
        labels: ['SENT'],
        receivedAt: NOW,
      }),
      message('m3', { from: 'Deals <deals@shop.example>', headers: { 'list-unsubscribe': '<mailto:x>' } }),
    ]);
    let index = await rows(t);
    expect(Object.keys(index).sort()).toEqual(['ann@acme.com', 'bo@acme.com', 'deals@shop.example']);
    expect(index['ann@acme.com']).toMatchObject({
      name: 'Ann Lee',
      sentCount: 1,
      receivedCount: 1,
      bulkCount: 0,
      lastSentAt: NOW,
      lastReceivedAt: NOW - DAY,
      accounts: [{ accountId: 'grant_work', sent: 1, received: 1, lastAt: NOW }],
    });
    expect(index['bo@acme.com'].name).toBe('Bo, Stone');
    expect(index['deals@shop.example'].bulkCount).toBe(1);
    expect(index['deals@shop.example'].score).toBeLessThan(index['ann@acme.com'].score - 1_000);
    expect(index['ann@acme.com'].searchText).toBe('ann lee ann acme com');

    // The same messages again (a repair sweep, a webhook) add nothing.
    await upsert(t, [
      message('m1', { unread: true }),
      message('m2', { from: 'me@lab86.io', to: 'ann@acme.com' }),
    ]);
    index = await rows(t);
    expect(index['ann@acme.com']).toMatchObject({ sentCount: 1, receivedCount: 1 });

    const migration = await t.run((ctx) =>
      ctx.db
        .query('dataMigrations')
        .withIndex('by_name', (q) => q.eq('name', CORRESPONDENT_MIGRATION))
        .first(),
    );
    expect(migration?.result?.cutoff).toBeNumber();
  });
});

describe('backfill migration', () => {
  test('a dry run writes nothing; the run counts old mail once and completes', async () => {
    const t = convexTest(schema, modules);
    await connect(t, 'grant_work', 'me@lab86.io');
    await connect(t, 'grant_home', 'me@gmail.com');
    await connect(t, 'grant_dead', 'old@acme.com');
    await t.mutation(api.accounts.markGrantReconnectNeeded, {
      internalSecret: SECRET,
      grantId: 'grant_dead',
      reason: 'Reconnect needed',
    });
    // Stored before the index existed: only the backfill can count these.
    await t.run(async (ctx) => {
      const base = {
        userId: USER,
        grantId: 'g',
        provider: 'google' as const,
        subject: 's',
        snippet: '',
        searchText: 's',
        labels: ['INBOX'],
        yearMonth: '2026-09',
        createdAt: 1,
        updatedAt: 1,
      };
      const insert = (accountId: string, id: string, from: string, to: string, receivedAt: number) =>
        ctx.db.insert('mailCorpusMessages', {
          ...base,
          accountId,
          providerMessageId: id,
          providerThreadId: id,
          from,
          to,
          receivedAt,
        });
      await insert('grant_work', 'w1', 'Ann Lee <ann@acme.com>', 'me@lab86.io', NOW - 3 * DAY);
      await insert('grant_work', 'w2', 'me@lab86.io', 'ann@acme.com, cy@acme.com', NOW - 2 * DAY);
      await insert('grant_work', 'w3', 'Ann Lee <ann@acme.com>', 'me@lab86.io', NOW - DAY);
      await insert('grant_home', 'h1', 'Mom <mom@gmail.com>', 'me@gmail.com', NOW - DAY);
      await insert('grant_dead', 'd1', 'ghost@x.io', 'old@acme.com', NOW - DAY);
    });

    const dry = await t.mutation(internal.correspondents.backfillCorrespondents, { dryRun: true, limit: 2 });
    expect(dry.done).toBe(false);
    await drain(t);
    expect(await t.run((ctx) => ctx.db.query('correspondents').collect())).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query('dataMigrations').collect())).toHaveLength(0);

    await t.mutation(internal.correspondents.backfillCorrespondents, { limit: 2 });
    await drain(t);
    const index = await rows(t);
    expect(Object.keys(index).sort()).toEqual(['ann@acme.com', 'cy@acme.com', 'mom@gmail.com']);
    expect(index['ann@acme.com']).toMatchObject({ sentCount: 1, receivedCount: 2 });
    const migration = await t.run((ctx) => ctx.db.query('dataMigrations').first());
    expect(migration).toMatchObject({ status: 'completed' });
    expect(migration?.result?.totals).toMatchObject({ accounts: 2, messages: 4, counted: 4 });

    // A second run does nothing, and new mail after the cutoff counts once.
    expect(await t.mutation(internal.correspondents.backfillCorrespondents, {})).toMatchObject({
      done: true,
      alreadyCompleted: true,
    });
    await upsert(t, [message('n1', { receivedAt: NOW })]);
    expect((await rows(t))['ann@acme.com'].receivedCount).toBe(3);

    // One user only: a rerun for that user adds the same mail again, so it is
    // only for users the full run did not see. It does not touch the marker.
    const userRun = await t.mutation(internal.correspondents.backfillCorrespondents, {
      userId: 'nobody',
    });
    expect(userRun).toMatchObject({ done: true });
  });
});

describe('account removal', () => {
  test('rows of only that mailbox go; shared rows lose its counts', async () => {
    const t = convexTest(schema, modules);
    await connect(t, 'grant_work', 'me@lab86.io');
    await connect(t, 'grant_home', 'me@gmail.com');
    await upsert(t, [message('w1', {}), message('w2', { from: 'solo@acme.com' })], 'grant_work');
    await upsert(t, [message('h1', { to: 'me@gmail.com' })], 'grant_home');
    const before = (await rows(t))['ann@acme.com'];
    await t.mutation(api.accounts.deleteConnectedAccount, {
      internalSecret: SECRET,
      userId: USER,
      accountId: 'grant_work',
    });
    await drain(t);
    const index = await rows(t);
    expect(Object.keys(index)).toEqual(['ann@acme.com']);
    expect(index['ann@acme.com']).toMatchObject({
      receivedCount: 1,
      accounts: [{ accountId: 'grant_home', sent: 0, received: 1 }],
    });
    expect(index['ann@acme.com'].frecency).toBeLessThan(before.frecency);
  });
});

describe('suggestRecipients', () => {
  test('ranks the index with contacts, boosts, and exclusions', async () => {
    const t = convexTest(schema, modules);
    await connect(t, 'grant_work', 'me@lab86.io');
    await connect(t, 'grant_home', 'me@gmail.com');
    await upsert(t, [
      message('s1', {
        from: 'me@lab86.io',
        to: 'Jakob Langtry <jakob@lab86.io>',
        receivedAt: NOW,
        labels: ['SENT'],
      }),
      message('s2', {
        from: 'me@lab86.io',
        to: 'jane@partner.example',
        receivedAt: NOW - DAY,
        labels: ['SENT'],
      }),
      message('r1', { from: 'Jay Bulk <jay@news.example>', headers: { 'list-id': 'news' } }),
    ]);
    await t.mutation(api.contacts.upsertContactBatch, {
      internalSecret: SECRET,
      userId: USER,
      accountId: 'grant_home',
      provider: 'google',
      contacts: [
        normalizeNylasContact(
          {
            id: 'c1',
            displayName: 'Jane Partner',
            emails: [{ email: 'jane@partner.example' }, { email: 'jane@home.example' }],
          },
          'address_book',
        )!,
        normalizeNylasContact(
          { id: 'c2', displayName: 'Jo Unseen', emails: [{ email: 'jo@unseen.example' }] },
          'address_book',
        )!,
      ],
    });
    const suggest = (query: string, extra: Record<string, unknown> = {}) =>
      t.query(api.correspondents.suggestRecipients, {
        internalSecret: SECRET,
        userId: USER,
        query,
        now: NOW,
        ...extra,
      });

    // Jane: saved contact, written to yesterday. Jakob: same work domain,
    // written to today. Jo: saved, no mail. Jay: list mail only, last.
    const j = await suggest('j');
    expect(j.items.map((item: any) => item.email)).toEqual([
      'jane@partner.example',
      'jakob@lab86.io',
      'jo@unseen.example',
      'jay@news.example',
    ]);
    expect(j.items[0]).toMatchObject({
      name: 'Jane Partner',
      savedContact: true,
      alternateEmails: ['jane@home.example'],
    });
    expect(Object.values(j.items[2]).includes(undefined)).toBe(false);

    const initials = await suggest('jl');
    expect(initials.items[0].email).toBe('jakob@lab86.io');
    const typo = await suggest('jkaob');
    expect(typo.items[0].email).toBe('jakob@lab86.io');
    const prefix = await suggest('jane@');
    expect(prefix.items[0].email).toBe('jane@partner.example');
    const typed = await suggest('new@else.example');
    expect(typed.items[0]).toMatchObject({ email: 'new@else.example', sources: ['typed'] });
    const known = await suggest('jane@partner.example');
    expect(known.items[0].email).toBe('jane@partner.example');
    const excluded = await suggest('ja', { exclude: ['JAKOB@lab86.io'] });
    expect(excluded.items.map((item: any) => item.email)).not.toContain('jakob@lab86.io');
    const empty = await suggest('', { limit: 2 });
    expect(empty.items.map((item: any) => item.email)).toEqual(['jane@partner.example', 'jakob@lab86.io']);
    const self = await suggest('me');
    expect(self.items.map((item: any) => item.email)).not.toContain('me@lab86.io');
    const fromHome = await suggest('ja', { fromAccountId: 'grant_home', limit: 20 });
    expect(fromHome.items.length).toBeGreaterThan(0);
    await expect(
      t.query(api.correspondents.suggestRecipients, { internalSecret: 'bad', userId: USER, query: 'j' }),
    ).rejects.toThrow('Invalid Convex internal secret');
  });
});
