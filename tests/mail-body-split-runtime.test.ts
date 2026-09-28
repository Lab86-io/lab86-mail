import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api, internal } from '../convex/_generated/api';
import type { Doc } from '../convex/_generated/dataModel';
import schema from '../convex/schema';
import { bodyPartHash, joinBodyHash } from '../lib/mail/corpus-body';

// IO-1: the body split of the mail corpus. Small documents in
// mailCorpusMessages, bodies in mailCorpusBodies, a hash skip on each write,
// and the migration that moves the bodies of old documents.

const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/mailCorpus.ts': () => import('../convex/mailCorpus'),
  '../convex/mailBodies.ts': () => import('../convex/mailBodies'),
  '../convex/liveMail.ts': () => import('../convex/liveMail'),
  '../convex/accounts.ts': () => import('../convex/accounts'),
};

const SECRET = 'mail-body-split-secret';
const USER = 'body_split_user';
const TS = Date.UTC(2026, 8, 20, 9, 0, 0);
const scope = {
  internalSecret: SECRET,
  userId: USER,
  accountId: 'account_1',
  grantId: 'grant_1',
  provider: 'google' as const,
};
let previousSecret: string | undefined;
beforeAll(() => {
  previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
});

type Harness = ReturnType<typeof harness>;
function harness() {
  return convexTest(schema, modules);
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    providerMessageId: 'message_1',
    providerThreadId: 'thread_1',
    subject: 'Project kickoff',
    from: 'alice@example.com',
    to: 'me@example.com',
    receivedAt: TS,
    snippet: 'Kicking off the giraffe project',
    textBody: 'Kicking off the giraffe project this week.\n> earlier note',
    htmlBody: '<p>Kicking off the <b>giraffe</b> project this week.</p>',
    searchText: 'ignored by the server',
    labels: ['INBOX'],
    unread: true,
    ...overrides,
  };
}

async function ingest(t: Harness, messages: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  return t.mutation(api.mailCorpus.upsertCorpusBatch, {
    ...scope,
    threads: [],
    messages: messages as never,
    ...extra,
  });
}

async function all<T extends 'mailCorpusMessages' | 'mailCorpusBodies' | 'mailCorpusThreads'>(
  t: Harness,
  table: T,
) {
  return (await t.run((ctx) => ctx.db.query(table).collect())) as Array<Doc<T>>;
}

// A document as the writer stored it before the body split.
async function insertLegacy(t: Harness, overrides: Record<string, unknown> = {}) {
  return t.run(async (ctx) =>
    ctx.db.insert('mailCorpusMessages', {
      userId: USER,
      accountId: scope.accountId,
      grantId: scope.grantId,
      provider: 'google',
      providerMessageId: 'legacy_1',
      providerThreadId: 'thread_legacy',
      subject: 'Old invoice',
      from: 'billing@example.com',
      to: 'me@example.com',
      receivedAt: TS - 1000,
      snippet: 'Your invoice',
      textBody: 'Your invoice is attached.\nPay by Friday.',
      htmlBody: '<p>Your invoice is attached.</p>',
      searchText: 'old invoice billing your invoice is attached pay by friday',
      labels: ['INBOX'],
      unread: false,
      yearMonth: '2026-09',
      createdAt: TS,
      updatedAt: TS,
      ...overrides,
    } as any),
  );
}

async function connect(t: Harness, accountId = scope.accountId, status: 'connected' | 'error' = 'connected') {
  await t.run((ctx) =>
    ctx.db.insert('connectedAccounts', {
      userId: USER,
      accountId,
      email: `${accountId}@example.com`,
      provider: 'google',
      grantId: `grant-${accountId}`,
      status,
      scopes: [],
      createdAt: TS,
      updatedAt: TS,
    }),
  );
}

describe('the writer', () => {
  test('stores the small fields and the body in separate documents', async () => {
    const t = harness();
    await ingest(t, [message()]);
    const [doc] = await all(t, 'mailCorpusMessages');
    const [body] = await all(t, 'mailCorpusBodies');
    expect(doc.textBody).toBeUndefined();
    expect(doc.htmlBody).toBeUndefined();
    expect(doc.bodyHash).toBe(
      joinBodyHash({ text: bodyPartHash(message().textBody), html: bodyPartHash(message().htmlBody) }),
    );
    // The server builds the search text: header line, then the excerpt.
    expect(doc.searchText.startsWith('Project kickoff alice@example.com me@example.com')).toBe(true);
    expect(doc.searchText.slice(doc.excerptAt!)).toBe(message().textBody);
    expect(body).toMatchObject({
      userId: USER,
      accountId: scope.accountId,
      providerMessageId: 'message_1',
      providerThreadId: 'thread_1',
      textBody: message().textBody,
      htmlBody: message().htmlBody,
    });
  });

  test('an unchanged message writes nothing, and its thread row stays', async () => {
    const t = harness();
    await ingest(t, [message()]);
    const before = {
      doc: (await all(t, 'mailCorpusMessages'))[0],
      body: (await all(t, 'mailCorpusBodies'))[0],
      thread: (await all(t, 'mailCorpusThreads'))[0],
    };
    await ingest(t, [message()]);
    const after = {
      doc: (await all(t, 'mailCorpusMessages'))[0],
      body: (await all(t, 'mailCorpusBodies'))[0],
      thread: (await all(t, 'mailCorpusThreads'))[0],
    };
    expect(after).toEqual(before);
  });

  test('a flag change writes the small document only; a body change writes the body', async () => {
    const t = harness();
    await ingest(t, [message()]);
    const body = (await all(t, 'mailCorpusBodies'))[0];
    await ingest(t, [message({ unread: false })]);
    expect((await all(t, 'mailCorpusBodies'))[0]).toEqual(body);
    expect((await all(t, 'mailCorpusMessages'))[0].unread).toBe(false);
    expect((await all(t, 'mailCorpusThreads'))[0].unread).toBe(false);
    await ingest(t, [message({ htmlBody: '<p>Changed</p>' })]);
    const [changed] = await all(t, 'mailCorpusBodies');
    expect(changed.htmlBody).toBe('<p>Changed</p>');
    expect(changed.textBody).toBe(message().textBody);
  });

  test('a metadata-only write keeps the body and the excerpt', async () => {
    const t = harness();
    await ingest(t, [message()]);
    await ingest(t, [message({ textBody: undefined, htmlBody: undefined, subject: 'New subject' })]);
    const [doc] = await all(t, 'mailCorpusMessages');
    const [body] = await all(t, 'mailCorpusBodies');
    expect(doc.subject).toBe('New subject');
    expect(doc.searchText).toContain('New subject');
    expect(doc.searchText.slice(doc.excerptAt!)).toBe(message().textBody);
    expect(body.textBody).toBe(message().textBody);
  });

  test('a message with no body has no body document', async () => {
    const t = harness();
    await ingest(t, [message({ textBody: undefined, htmlBody: undefined })]);
    expect(await all(t, 'mailCorpusBodies')).toEqual([]);
    const [doc] = await all(t, 'mailCorpusMessages');
    expect(doc.bodyHash).toBe('-.-');
  });

  test('a message that moves to another thread takes its body along', async () => {
    const t = harness();
    await ingest(t, [message()]);
    await ingest(t, [message({ providerThreadId: 'thread_2' })]);
    expect((await all(t, 'mailCorpusBodies'))[0].providerThreadId).toBe('thread_2');
  });

  test('the first write of a document from before the split moves its body', async () => {
    const t = harness();
    await insertLegacy(t);
    await ingest(t, [
      message({
        providerMessageId: 'legacy_1',
        providerThreadId: 'thread_legacy',
        subject: 'Old invoice',
        from: 'billing@example.com',
        receivedAt: TS - 1000,
        snippet: 'Your invoice',
        textBody: undefined,
        htmlBody: undefined,
        unread: false,
      }),
    ]);
    const [doc] = await all(t, 'mailCorpusMessages');
    const [body] = await all(t, 'mailCorpusBodies');
    expect(doc.textBody).toBeUndefined();
    expect(doc.htmlBody).toBeUndefined();
    expect(body.textBody).toBe('Your invoice is attached.\nPay by Friday.');
    expect(body.htmlBody).toBe('<p>Your invoice is attached.</p>');
    expect(doc.searchText.slice(doc.excerptAt!)).toBe(body.textBody!);
  });

  test('deletes remove the body documents', async () => {
    const t = harness();
    await ingest(t, [message(), message({ providerMessageId: 'message_2' })]);
    await t.mutation(api.mailCorpus.deleteCorpusMessage, {
      internalSecret: SECRET,
      userId: USER,
      accountId: scope.accountId,
      providerMessageId: 'message_1',
    });
    expect((await all(t, 'mailCorpusBodies')).map((row) => row.providerMessageId)).toEqual(['message_2']);
    await t.mutation(api.mailCorpus.deleteCorpusThread, {
      internalSecret: SECRET,
      userId: USER,
      accountId: scope.accountId,
      providerThreadId: 'thread_1',
    });
    expect(await all(t, 'mailCorpusBodies')).toEqual([]);
  });

  test('the account purge removes the body documents', async () => {
    const t = harness();
    await ingest(t, [message(), message({ providerMessageId: 'message_2' })]);
    await t.mutation(internal.accounts.purgeAccountDataBatch, { userId: USER, accountId: scope.accountId });
    expect(await all(t, 'mailCorpusBodies')).toEqual([]);
    expect(await all(t, 'mailCorpusMessages')).toEqual([]);
  });
});

describe('the readers', () => {
  test('the open thread, the bundle and one message read the body table', async () => {
    const t = harness();
    await ingest(t, [message()]);
    const live = await t.withIdentity({ subject: USER }).query(api.liveMail.getThread, {
      account: scope.accountId,
      threadId: 'thread_1',
    });
    expect(live?.messages[0]).toMatchObject({
      textBody: message().textBody,
      htmlBody: message().htmlBody,
    });
    const bundle = await t.query(api.mailCorpus.getCorpusThreadBundle, {
      internalSecret: SECRET,
      userId: USER,
      accountId: scope.accountId,
      providerThreadId: 'thread_1',
    });
    expect(bundle?.bodiesComplete).toBe(true);
    expect(bundle?.messages[0].htmlBody).toBe(message().htmlBody);
    const one = await t.query(api.mailCorpus.getCorpusMessage, {
      internalSecret: SECRET,
      userId: USER,
      accountId: scope.accountId,
      providerMessageId: 'message_1',
    });
    expect(one?.textBody).toBe(message().textBody);
  });

  test('a message with no stored HTML reads as not hydrated', async () => {
    const t = harness();
    await ingest(t, [message({ htmlBody: undefined })]);
    const bundle = await t.query(api.mailCorpus.getCorpusThreadBundle, {
      internalSecret: SECRET,
      userId: USER,
      accountId: scope.accountId,
      providerThreadId: 'thread_1',
    });
    expect(bundle?.messages[0].htmlBody).toBeNull();
    expect(bundle?.bodiesComplete).toBe(false);
  });

  test('readers work on documents from before the split during the migration', async () => {
    const t = harness();
    await ingest(t, [message()]);
    await insertLegacy(t, { providerThreadId: 'thread_1', receivedAt: TS + 1 });
    await t.run(async (ctx) => {
      // The thread row is written by the writer; the legacy row joins it.
      const row = await ctx.db.query('mailCorpusThreads').first();
      await ctx.db.patch(row!._id, { messageCount: 2 });
    });
    const live = await t.withIdentity({ subject: USER }).query(api.liveMail.getThread, {
      account: scope.accountId,
      threadId: 'thread_1',
    });
    expect(live?.messages.map((entry: any) => entry.htmlBody)).toEqual([
      message().htmlBody,
      '<p>Your invoice is attached.</p>',
    ]);
    const search = await t.query(api.mailCorpus.searchCorpusMessages, {
      internalSecret: SECRET,
      userId: USER,
      accountId: scope.accountId,
    });
    expect(search.every((row: any) => row.htmlBody === undefined)).toBe(true);
    expect(search.find((row: any) => row.providerMessageId === 'legacy_1')?.textBody).toBe(
      'Your invoice is attached.\nPay by Friday.',
    );
    const timeline = await t.query(api.mailCorpus.listCorpusThreadMessages, {
      internalSecret: SECRET,
      userId: USER,
      accountId: scope.accountId,
      providerThreadId: 'thread_1',
    });
    expect(timeline).toHaveLength(2);
    expect(timeline.every((row: any) => row.htmlBody === undefined)).toBe(true);
  });

  test('text search matches the subject, the sender and the start of the body', async () => {
    const t = harness();
    await ingest(t, [
      message(),
      message({
        providerMessageId: 'message_2',
        providerThreadId: 'thread_2',
        subject: 'Quarterly numbers',
        from: 'bob@example.com',
        snippet: 'See the report',
        textBody: 'See the attached report about zebras.',
      }),
    ]);
    const find = async (query: string) =>
      (
        await t.query(api.mailCorpus.searchCorpusMessages, {
          internalSecret: SECRET,
          userId: USER,
          accountId: scope.accountId,
          query,
        })
      ).map((row: any) => row.providerMessageId);
    expect(await find('quarterly')).toEqual(['message_2']);
    expect(await find('bob')).toEqual(['message_2']);
    expect(await find('zebras')).toEqual(['message_2']);
    expect(await find('giraffe')).toEqual(['message_1']);
    const page = await t.query(api.mailCorpus.searchCorpusMessagesPage, {
      internalSecret: SECRET,
      userId: USER,
      accountId: scope.accountId,
      query: 'zebras',
    });
    expect(page.items[0].textBody).toContain('zebras');
  });

  test('the live list reads one merged page for many mailboxes and falls back when it must', async () => {
    const t = harness();
    await ingest(t, [message()]);
    await t.mutation(api.mailCorpus.upsertCorpusBatch, {
      ...scope,
      accountId: 'account_2',
      threads: [],
      messages: [message({ providerMessageId: 'm2', providerThreadId: 't2', receivedAt: TS + 5 })] as never,
    });
    const user = t.withIdentity({ subject: USER });
    const both = await user.query(api.liveMail.listThreads, {
      accountIds: [scope.accountId, 'account_2'],
      limit: 5,
    });
    expect(both.items.map((item: any) => item._id)).toEqual(['t2', 'thread_1']);
    // Many newer rows of a third mailbox fill the merged read; the account
    // reads still find the requested mailboxes.
    await t.mutation(api.mailCorpus.upsertCorpusBatch, {
      ...scope,
      accountId: 'account_3',
      threads: [],
      messages: Array.from({ length: 4 }, (_, index) =>
        message({
          providerMessageId: `n${index}`,
          providerThreadId: `n${index}`,
          receivedAt: TS + 100 + index,
        }),
      ) as never,
    });
    const page = await user.query(api.liveMail.listThreads, {
      accountIds: [scope.accountId, 'account_2'],
      limit: 2,
    });
    expect(page.items.map((item: any) => item._id)).toEqual(['t2', 'thread_1']);
  });
});

describe('the migration', () => {
  test('a dry run counts and writes nothing', async () => {
    const t = harness();
    await connect(t);
    await insertLegacy(t);
    const result = await t.mutation(internal.mailBodies.migrateMessageBodies, { dryRun: true });
    expect(result.done).toBe(false);
    expect(result.totals).toMatchObject({ scanned: 1, split: 1, bodies: 1, alreadySplit: 0 });
    expect(result.totals.movedChars).toBeGreaterThan(40);
    expect(await all(t, 'mailCorpusBodies')).toEqual([]);
    expect((await all(t, 'mailCorpusMessages'))[0].textBody).toBeDefined();
  });

  test('moves bodies in pages, live mailboxes first, and a second run writes nothing', async () => {
    const t = harness();
    await connect(t);
    await connect(t, 'dead', 'error');
    for (let index = 0; index < 5; index++)
      await insertLegacy(t, { providerMessageId: `legacy_${index}`, receivedAt: TS - index });
    await insertLegacy(t, { accountId: 'dead', providerMessageId: 'dead_1' });
    // A document with no inline body gets its hash and no body document.
    await insertLegacy(t, { providerMessageId: 'empty', textBody: undefined, htmlBody: undefined });
    let result = await t.mutation(internal.mailBodies.migrateMessageBodies, { limit: 2 });
    let pages = 1;
    while (!result.done && pages < 20) {
      const args: any = await t.run(async (ctx) => {
        const jobs = await ctx.db.system.query('_scheduled_functions').collect();
        return jobs.filter((job) => job.state.kind === 'pending').at(-1)?.args[0];
      });
      if (!args) break;
      result = await t.mutation(internal.mailBodies.migrateMessageBodies, args);
      pages++;
    }
    expect(result.done).toBe(true);
    expect(result.totals).toMatchObject({ accounts: 1, scanned: 6, split: 6, bodies: 5 });
    const docs = await all(t, 'mailCorpusMessages');
    const live = docs.filter((doc) => doc.accountId === scope.accountId);
    expect(
      live.every((doc) => doc.textBody === undefined && doc.htmlBody === undefined && doc.bodyHash),
    ).toBe(true);
    // The mail of an account that is not connected moves only on request.
    expect(docs.find((doc) => doc.providerMessageId === 'dead_1')?.textBody).toBeDefined();
    expect((await all(t, 'mailCorpusBodies')).length).toBe(5);
    expect(docs.find((doc) => doc.providerMessageId === 'empty')?.bodyHash).toBe('-.-');
    const migration = await t.run((ctx) => ctx.db.query('dataMigrations').first());
    expect(migration?.name).toBe('mailCorpusBodySplit');

    const again = await t.mutation(internal.mailBodies.migrateMessageBodies, {});
    expect(again.totals).toMatchObject({ scanned: 6, split: 0, alreadySplit: 6 });
    const withDead = await t.mutation(internal.mailBodies.migrateMessageBodies, {
      includeDisconnected: true,
      accountIndex: 1,
      userId: USER,
    });
    expect(withDead.totals).toMatchObject({ scanned: 1, split: 1 });
  });

  test('a cursor whose mailbox is gone starts again at the same position', async () => {
    const t = harness();
    await connect(t);
    await insertLegacy(t);
    const result = await t.mutation(internal.mailBodies.migrateMessageBodies, {
      account: { userId: USER, accountId: 'removed' },
      cursor: 'stale',
      accountIndex: 0,
    });
    expect(result.totals.split).toBe(1);
  });
});
