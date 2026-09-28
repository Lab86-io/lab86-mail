import { afterAll, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import { convexTest, type TestConvex } from 'convex-test';
import { api, internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import {
  ACCOUNT_KEYED_ROWS,
  CONTENT_ITEM_BYTES,
  evidenceNamesAccount,
  PURGE_PASS_BYTES,
  PURGE_ROW_BYTES,
  purgePassRoom,
  storedBytes,
} from '../convex/accounts';
import schema from '../convex/schema';

// Disconnect and the 30-day dead-account purge delete one set of mailbox
// data through one pass (purgeAccountPass). These tests seed one row of every
// kind for two mailboxes whose ids share a prefix, run each purge on the
// first, and check that the first mailbox's rows are gone and the second
// mailbox's rows are all still there.

const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/accounts.ts': () => import('../convex/accounts'),
  '../convex/correspondents.ts': () => import('../convex/correspondents'),
  '../convex/deadAccounts.ts': () => import('../convex/deadAccounts'),
  '../convex/narrative.ts': () => import('../convex/narrative'),
};
const SECRET = 'account-purge-secret';
const USER = 'user_purge';
const GONE = 'grant_a';
// The kept id starts with the purged id, so a prefix match without a
// separator would delete its rows too.
const KEPT = 'grant_a2';
const T0 = Date.UTC(2026, 8, 1);
const DAY = 86_400_000;

let previousSecret: string | undefined;
beforeAll(() => {
  previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});
afterAll(() => {
  setSystemTime();
  if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
});

type T = TestConvex<typeof schema>;

const connect = (t: T, grantId: string) =>
  t.mutation(api.accounts.upsertConnectedAccount, {
    internalSecret: SECRET,
    userId: USER,
    email: `${grantId}@example.com`,
    provider: 'google',
    grantId,
    scopes: ['email'],
  });

async function drain(t: T) {
  for (let wave = 0; wave < 40; wave++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await t.finishInProgressScheduledFunctions();
  }
}

const threadKey = (account: string) => JSON.stringify([account, 't1']);

/** One row of every kind of mailbox data for `account`. */
async function seedMailbox(t: T, account: string) {
  return t.run(async (ctx) => {
    const base = { userId: USER, accountId: account, grantId: account, provider: 'google' as const };
    const ts = { createdAt: T0, updatedAt: T0 };
    await ctx.db.insert('calendarSyncStates', { ...base, status: 'ready', ...ts });
    await ctx.db.insert('calendars', { ...base, providerCalendarId: 'cal', name: 'Cal', ...ts });
    await ctx.db.insert('contactSyncStates', { ...base, status: 'ready', ...ts });
    await ctx.db.insert('mailCorpusThreads', {
      ...base,
      providerThreadId: 't1',
      subject: 'Quarterly plan',
      fromAddress: 'ann@example.com',
      lastDate: T0,
      snippet: 'The plan',
      labels: ['INBOX'],
      unread: true,
      jev: { status: 'accepted' },
      jevStatus: 'accepted',
      yearMonth: '2026-09',
      ...ts,
    });
    await ctx.db.insert('mailCorpusMessages', {
      ...base,
      providerMessageId: 'm1',
      providerThreadId: 't1',
      subject: 'Quarterly plan',
      from: 'ann@example.com',
      to: 'me@example.com',
      receivedAt: T0,
      snippet: 'The plan',
      searchText: 'quarterly plan',
      labels: ['INBOX'],
      yearMonth: '2026-09',
      ...ts,
    });
    await ctx.db.insert('mailCorpusBodies', {
      userId: USER,
      accountId: account,
      providerMessageId: 'm1',
      providerThreadId: 't1',
      textBody: 'The plan in full.',
      ...ts,
    });
    await ctx.db.insert('mailLabelMembership', {
      userId: USER,
      accountId: account,
      providerThreadId: 't1',
      labelKey: 'custom:x',
      lastDate: T0,
      unread: true,
    });
    await ctx.db.insert('mailWebhookEvents', {
      eventId: `${account}-w`,
      type: 'message.created',
      userId: USER,
      accountId: account,
      payload: {},
      status: 'processed',
      receivedAt: T0,
    });
    await ctx.db.insert('mailOneTimeCodes', {
      userId: USER,
      accountId: account,
      providerMessageId: 'm1',
      providerThreadId: 't1',
      code: '123456',
      label: 'Code',
      issuer: 'Example',
      serviceIdentifiers: ['example.com'],
      confidence: 1,
      receivedAt: T0,
      expiresAt: T0 + DAY,
      status: 'active',
      ...ts,
    });
    await ctx.db.insert('mailSnoozes', {
      userId: USER,
      accountId: account,
      threadId: 't1',
      untilTs: T0 + DAY,
      status: 'active',
      ...ts,
    });
    await ctx.db.insert('calendarEvents', {
      ...base,
      providerEventId: 'e1',
      providerCalendarId: 'cal',
      title: 'Review',
      startAt: T0,
      endAt: T0 + 1,
      ...ts,
    });
    const areaId = await ctx.db.insert('areas', {
      userId: USER,
      name: `Area ${account}`,
      kind: 'project',
      status: 'active',
      ...ts,
    });
    await ctx.db.insert('areaArtifactLinks', {
      userId: USER,
      areaId,
      artifactKind: 'mailThread',
      artifactId: 't1',
      accountId: account,
      role: 'primary',
      status: 'verified',
      sourceRefs: [],
      confirmationRefs: [],
      ...ts,
    });
    const contactId = await ctx.db.insert('contacts', {
      userId: USER,
      accountId: account,
      provider: 'google',
      source: 'address_book',
      providerContactId: 'c1',
      emails: [{ email: 'ann@example.com' }],
      searchText: 'ann',
      contentHash: 'h',
      ...ts,
    });
    await ctx.db.insert('contactEmails', {
      userId: USER,
      accountId: account,
      contactId,
      email: 'ann@example.com',
      source: 'address_book',
      weight: 1,
    });
    const items: Id<'contentItems'>[] = [];
    for (const [source, externalId] of [
      ['mail', 't1'],
      ['attachment', JSON.stringify(['m1', 'a1'])],
    ]) {
      const itemId = await ctx.db.insert('contentItems', {
        userId: USER,
        key: `${source}:${account}:${externalId}`,
        connectionId: account,
        source,
        externalId,
        title: 'Quarterly plan',
        text: 'The plan in full.',
        version: 'v1',
        modifiedAt: T0,
        indexedAt: T0,
        partial: false,
        deleted: false,
        labels: { kind: 'work' },
        status: 'ready',
        attempts: 1,
        nextAttemptAt: 0,
      });
      for (let i = 0; i < 2; i++)
        await ctx.db.insert('contentChunks', {
          userId: USER,
          itemId,
          version: 'v1',
          text: `chunk ${i}`,
          embedding: new Array(1536).fill(0),
        });
      items.push(itemId);
    }
    const doc = (kind: string, key: string, ref?: string) =>
      ctx.db.insert('userDocs', { userId: USER, kind, key, ref, doc: { account }, ...ts });
    await doc('thread', `${account}:t1`, account);
    await doc('draft', `draft-${account}`, account);
    await doc('proofDismissal', threadKey(account), account);
    await doc('msgCache', `${account}:m1`, `${account}:t1`);
    await doc('threadInsight', `${account}:t1`);
    await doc('trackedThread', `${account}:t1`, `${account}:t1`);
    await doc('dailyReportThreadDismissal', threadKey(account), 'thread');
    for (const source of [`mail:${account}`, `calendar:${account}`])
      await ctx.db.insert('narrativeEntries', {
        userId: USER,
        key: `obs:${source}`,
        level: 'observation',
        title: 'Quarterly plan',
        text: 'Email conversation: Quarterly plan.',
        source,
        sourceIds: [],
        topics: [],
        trust: 'observed',
        occurredAt: T0,
        observedAt: T0,
        updatedAt: T0,
        current: true,
        pinned: false,
      });
    const notice = (dedupeKey: string) =>
      ctx.db.insert('albatrossNotifications', {
        userId: USER,
        type: 'mail_message',
        title: `notice ${account}`,
        body: 'Quarterly plan',
        deepLink: '/mail',
        dedupeKey,
        status: 'delivered',
        scheduledFor: T0,
        ...ts,
      });
    const mailNotice = await notice(`mail-message:${account}:m1`);
    await notice(`urgent-mail:${account}:m2`);
    await ctx.db.insert('notificationDeliveries', {
      userId: USER,
      notificationId: mailNotice,
      channel: 'in_app',
      status: 'sent',
      attemptCount: 1,
      providerId: account,
      scheduledFor: T0,
      ...ts,
    });
    await ctx.db.insert('nativePushDeliveries', {
      userId: USER,
      notificationId: mailNotice,
      token: `token-${account}`,
      status: 'delivered',
      attemptCount: 1,
      ...ts,
    });
    for (const dedupeKey of [`ics:${account}:m1`, `inline-event:${account}:m2`]) {
      const suggestionId = await ctx.db.insert('suggestions', {
        userId: USER,
        kind: 'event',
        status: 'pending',
        title: 'Review',
        payload: {},
        provenance: { source: 'email', accountId: account, threadId: 't1' },
        dedupeKey,
        createdAt: T0,
      });
      await notice(`event-suggestion:${String(suggestionId)}`);
    }
    const evidence = (fields: Record<string, unknown>) =>
      ctx.db.insert('albatrossEvidence', {
        userId: USER,
        sourceKind: 'mail_thread',
        sourceId: 't1',
        title: 'Reply received',
        occurredAt: T0,
        weight: 1,
        confidence: 1,
        trust: 'observed',
        dedupeKey: `reply:${account}`,
        searchText: 'Quarterly plan',
        ...ts,
        ...fields,
      });
    await evidence({ accountId: account });
    await evidence({
      sourceKind: 'calendar_event',
      dedupeKey: `area-link:${String(areaId)}:calendarEvent:${account}:e1`,
    });
    await ctx.db.insert('briefPreparations', {
      userId: USER,
      key: `prep-${account}`,
      seedId: items[0],
      seedVersion: 'v1',
      status: 'pending',
      draft: { title: 'Answer Ann' },
      sources: [{ _id: items[1], version: 'v1' }],
      userNotes: '',
      revision: 1,
      nextAttemptAt: 0,
      needsRefresh: false,
      ...ts,
    });
    return { items };
  });
}

/** Rows that belong to one mailbox, by table. Every count is 1 or more after seedMailbox. */
async function mailboxRows(t: T, account: string) {
  return t.run(async (ctx) => {
    const counts: Record<string, number> = {};
    const count = async (table: string, match: (row: any) => boolean) => {
      counts[table] =
        (counts[table] ?? 0) + (await (ctx.db.query(table as any) as any).collect()).filter(match).length;
    };
    for (const table of [
      'mailSyncStates',
      'calendarSyncStates',
      'calendars',
      'contactSyncStates',
      'mailCorpusThreads',
      'mailCorpusMessages',
      'mailCorpusBodies',
      'mailLabelMembership',
      'mailWebhookEvents',
      'mailOneTimeCodes',
      'mailSnoozes',
      'calendarEvents',
      'areaArtifactLinks',
      'contacts',
      'contactEmails',
    ])
      await count(table, (row) => row.accountId === account);
    await count('contentItems', (row) => row.connectionId === account);
    const items = new Set(
      (await ctx.db.query('contentItems').collect())
        .filter((row) => row.connectionId === account)
        .map((row) => row._id),
    );
    await count('contentChunks', (row) => items.has(row.itemId));
    await count('userDocs', (row) => row.doc?.account === account);
    await count('narrativeEntries', (row) => row.source.endsWith(`:${account}`));
    await count('albatrossNotifications', (row) => row.title === `notice ${account}`);
    await count('notificationDeliveries', (row) => row.providerId === account);
    await count('nativePushDeliveries', (row) => row.token === `token-${account}`);
    await count('suggestions', (row) => row.provenance.accountId === account);
    await count('albatrossEvidence', (row) => evidenceNamesAccount(row, account));
    await count('briefPreparations', (row) => row.key === `prep-${account}`);
    await count('correspondents', (row) => row.accounts.some((entry: any) => entry.accountId === account));
    return counts;
  });
}

async function seedShared(t: T) {
  await t.run(async (ctx) => {
    await ctx.db.insert('correspondents', {
      userId: USER,
      email: 'ann@example.com',
      sentCount: 1,
      receivedCount: 2,
      bulkCount: 0,
      frecency: 1,
      score: 1,
      accounts: [
        { accountId: GONE, sent: 1, received: 1, lastAt: T0 },
        { accountId: KEPT, sent: 0, received: 1, lastAt: T0 },
      ],
      searchText: 'ann@example.com',
      updatedAt: T0,
    });
    // A brief edition mixes every mailbox. It is not mailbox data and stays.
    await ctx.db.insert('userDocs', {
      userId: USER,
      kind: 'dailyReport',
      key: 'report-1',
      doc: { title: 'Morning' },
      createdAt: T0,
      updatedAt: T0,
    });
  });
}

async function setUp() {
  const t = convexTest(schema, modules);
  setSystemTime(new Date(T0));
  await connect(t, GONE);
  await connect(t, KEPT);
  await seedMailbox(t, GONE);
  await seedMailbox(t, KEPT);
  await seedShared(t);
  return t;
}

function expectAllGone(counts: Record<string, number>) {
  expect(Object.entries(counts).filter(([, n]) => n > 0)).toEqual([]);
}

function expectAllKept(counts: Record<string, number>) {
  expect(Object.entries(counts).filter(([, n]) => n === 0)).toEqual([]);
}

describe('both account purges delete the same mailbox data', () => {
  test('the seed covers every kind of row', async () => {
    const t = await setUp();
    const gone = await mailboxRows(t, GONE);
    expectAllKept(gone);
    expect(gone).toEqual(await mailboxRows(t, KEPT));
  });

  test('disconnect deletes the mailbox, its index, and what was made from it', async () => {
    const t = await setUp();
    await t.mutation(api.accounts.deleteConnectedAccount, {
      internalSecret: SECRET,
      userId: USER,
      accountId: GONE,
    });
    await drain(t);
    expectAllGone(await mailboxRows(t, GONE));
    expectAllKept(await mailboxRows(t, KEPT));
    const rest = await t.run(async (ctx) => ({
      accounts: (await ctx.db.query('connectedAccounts').collect()).map((row) => row.accountId),
      grants: (await ctx.db.query('providerGrants').collect()).map((row) => row.accountId),
      reports: (await ctx.db.query('userDocs').collect()).filter((row) => row.kind === 'dailyReport').length,
    }));
    expect(rest).toEqual({ accounts: [KEPT], grants: [KEPT], reports: 1 });
  });

  test('the dead-account purge deletes the same set and keeps the account row', async () => {
    const t = await setUp();
    await t.mutation(api.accounts.markGrantReconnectNeeded, {
      internalSecret: SECRET,
      grantId: GONE,
      reason: 'Reconnect needed',
    });
    await t.mutation(internal.deadAccounts.purgeDeadAccountBatch, { userId: USER, accountId: GONE });
    await drain(t);
    expectAllGone(await mailboxRows(t, GONE));
    expectAllKept(await mailboxRows(t, KEPT));
    const rows = await t.run(async (ctx) => ({
      accounts: await ctx.db.query('connectedAccounts').collect(),
      grants: (await ctx.db.query('providerGrants').collect()).map((row) => row.accountId).sort(),
    }));
    const dead = rows.accounts.find((row) => row.accountId === GONE);
    expect(dead).toMatchObject({ status: 'error' });
    expect(dead?.corpusPurgedAt).toBeNumber();
    // The grant row stays, so a later disconnect can still revoke the grant.
    expect(rows.grants).toEqual([GONE, KEPT]);
  });
});

describe('the disconnect purge chain', () => {
  test('it stops when the mailbox is connected again under the same id', async () => {
    const t = await setUp();
    expect(
      await t.mutation(internal.accounts.purgeAccountDataBatch, { userId: USER, accountId: GONE }),
    ).toEqual({ deleted: 0, stopped: 'reconnected' });
    expectAllKept(await mailboxRows(t, GONE));
  });

  test('it deletes a large mailbox in bounded passes', async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (let i = 0; i < 12; i++) {
        const itemId = await ctx.db.insert('contentItems', {
          userId: USER,
          key: `mail:${GONE}:t${i}`,
          connectionId: GONE,
          source: 'mail',
          externalId: `t${i}`,
          title: 'x',
          text: 'x',
          version: 'v',
          modifiedAt: T0,
          indexedAt: T0,
          partial: false,
          deleted: false,
          status: 'ready',
          attempts: 0,
          nextAttemptAt: 0,
        });
        for (let c = 0; c < 3; c++)
          await ctx.db.insert('contentChunks', {
            userId: USER,
            itemId,
            version: 'v',
            text: 'x',
            embedding: new Array(1536).fill(0),
          });
      }
      for (let i = 0; i < 300; i++)
        await ctx.db.insert('userDocs', {
          userId: USER,
          kind: 'thread',
          key: `${GONE}:t${i}`,
          ref: GONE,
          doc: {},
          createdAt: T0,
          updatedAt: T0,
        });
    });
    const first = await t.mutation(internal.accounts.purgeAccountDataBatch, {
      userId: USER,
      accountId: GONE,
    });
    // Five content items with their chunks, then as many thread-cache rows as
    // the byte room of the pass allows (a 64 KiB bound each).
    expect(first.byTable).toMatchObject({ contentItems: 5, contentChunks: 15 });
    expect(first.byTable.userDocs).toBeGreaterThan(100);
    expect(first.byTable.userDocs).toBeLessThanOrEqual(PURGE_PASS_BYTES / (64 * 1024));
    expect(first.bytes).toBeLessThanOrEqual(PURGE_PASS_BYTES);
    await drain(t);
    const left = await t.run(async (ctx) => ({
      items: (await ctx.db.query('contentItems').collect()).length,
      chunks: (await ctx.db.query('contentChunks').collect()).length,
      docs: (await ctx.db.query('userDocs').collect()).length,
    }));
    expect(left).toEqual({ items: 0, chunks: 0, docs: 0 });
  });
});

describe('rows with no account index', () => {
  test('evidenceNamesAccount matches the account id, the connection id, or a key segment', () => {
    expect(evidenceNamesAccount({ accountId: GONE, dedupeKey: 'reply:1' }, GONE)).toBe(true);
    expect(evidenceNamesAccount({ connectionId: GONE, dedupeKey: 'x' }, GONE)).toBe(true);
    expect(evidenceNamesAccount({ dedupeKey: `area-link:a:mailThread:${GONE}:t1` }, GONE)).toBe(true);
    expect(evidenceNamesAccount({ dedupeKey: `area-link:a:mailThread:${KEPT}:t1` }, GONE)).toBe(false);
    expect(evidenceNamesAccount({ accountId: KEPT, dedupeKey: 'reply:1' }, GONE)).toBe(false);
  });

  test('the receipt sweep reads every page and keeps rows of other mailboxes', async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (let i = 0; i < 130; i++)
        await ctx.db.insert('albatrossEvidence', {
          userId: USER,
          sourceKind: 'mail_thread',
          sourceId: 't1',
          accountId: i % 2 ? GONE : KEPT,
          title: 'Reply',
          occurredAt: T0,
          weight: 1,
          confidence: 1,
          trust: 'observed',
          dedupeKey: `reply:${i}`,
          searchText: 'x',
          createdAt: T0,
          updatedAt: T0,
        });
    });
    const first = await t.mutation(internal.accounts.purgeAccountDerivedRows, {
      userId: USER,
      accountId: GONE,
    });
    expect(first).toMatchObject({ deleted: 50, done: false });
    await drain(t);
    const left = await t.run(async (ctx) => await ctx.db.query('albatrossEvidence').collect());
    expect(left).toHaveLength(65);
    expect(left.every((row) => row.accountId === KEPT)).toBe(true);
  });

  test('a prepared item with a lost or unreadable source goes; a complete one stays', async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const item = (key: string) =>
        ctx.db.insert('contentItems', {
          userId: USER,
          key,
          connectionId: KEPT,
          source: 'mail',
          externalId: key,
          title: 'x',
          text: 'x',
          version: 'v',
          modifiedAt: T0,
          indexedAt: T0,
          partial: false,
          deleted: false,
          status: 'ready',
          attempts: 0,
          nextAttemptAt: 0,
        });
      const seed = await item('seed');
      const prep = (key: string, sources: unknown[]) =>
        ctx.db.insert('briefPreparations', {
          userId: USER,
          key,
          seedId: seed,
          seedVersion: 'v',
          status: 'resolved',
          sources,
          userNotes: '',
          revision: 1,
          nextAttemptAt: 0,
          needsRefresh: false,
          createdAt: T0,
          updatedAt: T0,
        });
      await prep('complete', [{ _id: seed, version: 'v' }]);
      await prep('unreadable', [{ _id: 'not-an-id', version: 'v' }]);
    });
    await t.mutation(internal.accounts.purgeAccountDerivedRows, {
      userId: USER,
      accountId: GONE,
      step: 2,
    });
    const keys = await t.run(async (ctx) =>
      (await ctx.db.query('briefPreparations').collect()).map((row) => row.key),
    );
    expect(keys).toEqual(['complete']);
  });

  test('the last step asks the memory cleanup to delete chapters built on deleted observations', async () => {
    const t = convexTest(schema, modules);
    await connect(t, KEPT);
    const ids = await t.run(async (ctx) => {
      await ctx.db.insert('narrativeSettings', {
        userId: USER,
        enabled: true,
        sources: [`mail:${GONE}`, `mail:${KEPT}`],
        timezone: 'UTC',
        model: 'current',
        revision: 1,
        createdAt: T0,
        updatedAt: T0,
      });
      const entry = (fields: Record<string, unknown>) =>
        ctx.db.insert('narrativeEntries', {
          userId: USER,
          title: 'x',
          text: 'x',
          sourceIds: [],
          topics: [],
          trust: 'observed',
          occurredAt: T0,
          observedAt: T0,
          updatedAt: T0,
          current: true,
          pinned: false,
          ...fields,
        } as any);
      const kept = await entry({ key: 'obs-kept', level: 'observation', source: `mail:${KEPT}` });
      const keptDay = await entry({ key: 'day-kept', level: 'day', source: 'day', sourceIds: [kept] });
      // The observation that this chapter summarizes was purged already.
      const lost = await entry({ key: 'obs-lost', level: 'observation', source: `mail:${GONE}` });
      const lostDay = await entry({ key: 'day-lost', level: 'day', source: 'day', sourceIds: [lost] });
      await ctx.db.delete(lost);
      return { keptDay, lostDay };
    });
    expect(
      await t.mutation(internal.accounts.purgeAccountDerivedRows, {
        userId: USER,
        accountId: GONE,
        step: 3,
      }),
    ).toMatchObject({ deleted: 0, done: true });
    await drain(t);
    const left = await t.run(async (ctx) =>
      (await ctx.db.query('narrativeEntries').collect()).map((row) => row._id),
    );
    expect(left).toContain(ids.keptDay);
    expect(left).not.toContain(ids.lostDay);
  });

  test('every keyed row reads an index that starts with userId and ends with its field', () => {
    const tables = (schema as any).tables;
    for (const entry of ACCOUNT_KEYED_ROWS) {
      const index = tables[entry.table]
        [' indexes']()
        .find((candidate: any) => candidate.indexDescriptor === entry.index);
      const expected = ['userId', ...(entry.kind === undefined ? [] : ['kind']), entry.field];
      expect(index?.fields.slice(0, expected.length), `${entry.table}.${entry.index}`).toEqual(expected);
    }
  });
});
