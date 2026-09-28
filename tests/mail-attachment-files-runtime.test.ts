import { afterAll, afterEach, beforeAll, describe, expect, mock, setSystemTime, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { convexTest, type TestConvex } from 'convex-test';
import { api, internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import {
  BACKFILL_PAGE,
  hexToBase64,
  QUEUE_ACCOUNT_WAIT_MS,
  QUEUE_LEASE_MS,
  QUEUE_MAX_ATTEMPTS,
  queueRetryDelay,
} from '../convex/mailAttachments';
import schema from '../convex/schema';
import { ATTACHMENT_STORE_MAX_BYTES } from '../lib/attachments/store-policy';

// Attachment files in encrypted Convex storage: the queue, the stored rows,
// deduplication, and deletion with the account, the user, the message, and
// the dead-account purge.

const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/mailAttachments.ts': () => import('../convex/mailAttachments'),
  '../convex/mailCorpus.ts': () => import('../convex/mailCorpus'),
  '../convex/mailBodies.ts': () => import('../convex/mailBodies'),
  '../convex/accounts.ts': () => import('../convex/accounts'),
  '../convex/correspondents.ts': () => import('../convex/correspondents'),
  '../convex/deadAccounts.ts': () => import('../convex/deadAccounts'),
  '../convex/liveMail.ts': () => import('../convex/liveMail'),
};

const SECRET = 'attachment-files-secret';
const USER = 'user_files';
const OTHER = 'user_other';
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 28, 12);
let previousSecret: string | undefined;
let previousUrl: string | undefined;
beforeAll(() => {
  previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  previousUrl = process.env.LAB86_MAIL_PUBLIC_URL;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
  if (previousUrl === undefined) delete process.env.LAB86_MAIL_PUBLIC_URL;
  else process.env.LAB86_MAIL_PUBLIC_URL = previousUrl;
});
afterEach(() => setSystemTime());

type T = TestConvex<typeof schema>;
const harness = () => {
  setSystemTime(new Date(NOW));
  return convexTest(schema, modules);
};

const pdf = { attachmentId: 'att_pdf', filename: 'Invoice.pdf', mimeType: 'application/pdf', size: 90_000 };
const pixel = { attachmentId: 'att_pixel', filename: 'p.gif', mimeType: 'image/gif', size: 43 };

async function addAccount(
  t: T,
  accountId: string,
  status: 'connected' | 'error' | 'disconnected' = 'connected',
  userId = USER,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert('connectedAccounts', {
      userId,
      accountId,
      email: `${accountId}@example.com`,
      provider: 'google',
      status,
      scopes: [],
      grantId: `grant_${accountId}`,
      ...(status === 'error' ? { errorSince: NOW - 40 * DAY } : {}),
      createdAt: NOW,
      updatedAt: NOW,
    });
  });
}

function message(id: string, overrides: Record<string, unknown> = {}) {
  return {
    providerMessageId: id,
    providerThreadId: `thread_${id}`,
    subject: 'Invoice',
    from: 'billing@example.com',
    to: 'me@example.com',
    receivedAt: NOW - DAY,
    snippet: 'Your invoice',
    textBody: 'Your invoice is attached.',
    htmlBody: '<p>Your invoice is attached.</p>',
    searchText: 'x',
    labels: ['INBOX'],
    attachments: [pdf, pixel],
    ...overrides,
  };
}

function ingest(t: T, accountId: string, messages: Record<string, unknown>[]) {
  return t.mutation(api.mailCorpus.upsertCorpusBatch, {
    internalSecret: SECRET,
    userId: USER,
    accountId,
    grantId: `grant_${accountId}`,
    provider: 'google',
    threads: [],
    messages: messages as never,
  });
}

const rows = <Name extends 'mailAttachmentQueue' | 'mailAttachmentFiles' | 'mailAttachmentBackfills'>(
  t: T,
  table: Name,
) => t.run((ctx) => ctx.db.query(table).collect());

const blobCount = (t: T) => t.run(async (ctx) => (await ctx.db.system.query('_storage').collect()).length);

async function upload(t: T, text: string) {
  const storageId = await t.run((ctx) => ctx.storage.store(new Blob([text])));
  return { storageId, sha256: createHash('sha256').update(text).digest('hex'), size: text.length };
}

function record(
  t: T,
  accountId: string,
  attachmentId: string,
  file: { sha256: string; size: number },
  extra = {},
) {
  return t.mutation(api.mailAttachments.recordFile, {
    internalSecret: SECRET,
    userId: USER,
    accountId,
    providerMessageId: 'm1',
    attachmentId,
    filename: 'Invoice.pdf',
    mimeType: 'application/pdf',
    size: file.size,
    sha256: file.sha256,
    ...extra,
  });
}

async function storeFile(t: T, accountId: string, attachmentId: string, text: string, messageId = 'm1') {
  const file = await upload(t, text);
  const result = await t.mutation(api.mailAttachments.recordFile, {
    internalSecret: SECRET,
    userId: USER,
    accountId,
    providerMessageId: messageId,
    attachmentId,
    filename: 'f.pdf',
    mimeType: 'application/pdf',
    size: file.size,
    sha256: file.sha256,
    storageId: file.storageId,
  });
  expect(result.status).toBe('stored');
  return file;
}

async function drain(t: T) {
  for (let wave = 0; wave < 20; wave++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await t.finishInProgressScheduledFunctions();
  }
}

describe('queue intake from the corpus writer', () => {
  test('new mail queues its files by the policy, once', async () => {
    const t = harness();
    await addAccount(t, 'acct');
    await ingest(t, 'acct', [
      message('m1'),
      message('old', { receivedAt: NOW - 61 * DAY }),
      message('spam', { labels: ['SPAM'] }),
      message('plain', { attachments: [] }),
    ]);
    const queue = await rows(t, 'mailAttachmentQueue');
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      userId: USER,
      accountId: 'acct',
      providerMessageId: 'm1',
      attachmentId: 'att_pdf',
      filename: 'Invoice.pdf',
      state: 'queued',
      attempts: 0,
      dueAt: NOW,
      receivedAt: NOW - DAY,
    });
    // The same batch again changes no attachment list and adds no row.
    await ingest(t, 'acct', [message('m1')]);
    expect(await rows(t, 'mailAttachmentQueue')).toHaveLength(1);
    // A changed list queues only the new file.
    const doc = {
      attachmentId: 'att_doc',
      filename: 'Plan.docx',
      mimeType: 'application/msword',
      size: 20_000,
    };
    await ingest(t, 'acct', [message('m1', { attachments: [pdf, pixel, doc] })]);
    expect((await rows(t, 'mailAttachmentQueue')).map((row) => row.attachmentId).sort()).toEqual([
      'att_doc',
      'att_pdf',
    ]);
  });

  test('a stored file is not queued again', async () => {
    const t = harness();
    await addAccount(t, 'acct');
    await storeFile(t, 'acct', 'att_pdf', 'pdf bytes');
    await ingest(t, 'acct', [message('m1')]);
    expect(await rows(t, 'mailAttachmentQueue')).toHaveLength(0);
  });
});

describe('claims and failures', () => {
  test('a claim leases due rows of live mail and cleans rows that have no work', async () => {
    const t = harness();
    await addAccount(t, 'acct');
    await addAccount(t, 'dead', 'error');
    await ingest(t, 'acct', [
      message('m1'),
      message('m2'),
      message('gone'),
      message('trashed'),
      message('stored'),
    ]);
    await ingest(t, 'dead', [message('d1')]);
    await t.run(async (ctx) => {
      const byId = async (id: string) =>
        ctx.db
          .query('mailCorpusMessages')
          .withIndex('by_account_message', (q) => q.eq('accountId', 'acct').eq('providerMessageId', id))
          .unique();
      await ctx.db.delete((await byId('gone'))!._id);
      await ctx.db.patch((await byId('trashed'))!._id, { labels: ['TRASH'] });
      // A queue row of a removed mailbox.
      await ctx.db.insert('mailAttachmentQueue', {
        userId: USER,
        accountId: 'removed',
        providerMessageId: 'r1',
        attachmentId: 'a',
        filename: 'a',
        mimeType: 'a',
        size: 1,
        receivedAt: NOW,
        state: 'queued',
        attempts: 0,
        dueAt: NOW - 1,
        createdAt: NOW,
        updatedAt: NOW,
      });
    });
    const stored = await upload(t, 'stored bytes');
    await t.run(async (ctx) => {
      await ctx.db.insert('mailAttachmentFiles', {
        userId: USER,
        accountId: 'acct',
        providerMessageId: 'stored',
        attachmentId: 'att_pdf',
        filename: 'f',
        mimeType: 'application/pdf',
        size: stored.size,
        sha256: stored.sha256,
        storageId: stored.storageId,
        createdAt: NOW,
      });
    });

    const claimed = await t.mutation(api.mailAttachments.claimQueue, {
      internalSecret: SECRET,
      userId: USER,
      limit: 10,
    });
    expect(claimed.map((item) => item.providerMessageId).sort()).toEqual(['m1', 'm2']);
    expect(claimed[0]).toMatchObject({ accountId: 'acct', attachmentId: 'att_pdf', attempts: 1 });
    const queue = await rows(t, 'mailAttachmentQueue');
    expect(queue.map((row) => row.providerMessageId).sort()).toEqual(['d1', 'm1', 'm2']);
    for (const row of queue.filter((entry) => entry.accountId === 'acct'))
      expect(row).toMatchObject({ attempts: 1, dueAt: NOW + QUEUE_LEASE_MS });
    // The row of a mailbox in error waits and counts no attempt.
    expect(queue.find((row) => row.accountId === 'dead')).toMatchObject({
      attempts: 0,
      dueAt: NOW + QUEUE_ACCOUNT_WAIT_MS,
    });
    // Leased rows are not due again until the lease ends.
    expect(
      await t.mutation(api.mailAttachments.claimQueue, { internalSecret: SECRET, userId: USER }),
    ).toEqual([]);
    setSystemTime(new Date(NOW + QUEUE_LEASE_MS));
    expect(
      await t.mutation(api.mailAttachments.claimQueue, { internalSecret: SECRET, userId: USER, limit: 1 }),
    ).toHaveLength(1);
  });

  test('a row whose mail left the window is dropped at claim time', async () => {
    const t = harness();
    await addAccount(t, 'acct');
    await ingest(t, 'acct', [message('m1', { receivedAt: NOW - 59 * DAY })]);
    setSystemTime(new Date(NOW + 2 * DAY));
    expect(
      await t.mutation(api.mailAttachments.claimQueue, { internalSecret: SECRET, userId: USER }),
    ).toEqual([]);
    expect(await rows(t, 'mailAttachmentQueue')).toEqual([]);
  });

  test('transient errors back off, and permanent or repeated errors stop the row', async () => {
    const t = harness();
    await addAccount(t, 'acct');
    await ingest(t, 'acct', [message('m1'), message('m2')]);
    const [first, second] = await t.mutation(api.mailAttachments.claimQueue, {
      internalSecret: SECRET,
      userId: USER,
    });
    const fail = (queueId: string, permanent: boolean, userId = USER) =>
      t.mutation(api.mailAttachments.failQueueItem, {
        internalSecret: SECRET,
        userId,
        queueId,
        permanent,
        error: `503 ${'x'.repeat(400)}`,
      });
    expect(await fail('not-an-id', false)).toEqual({ ok: false });
    expect(await fail(first.queueId, false, OTHER)).toEqual({ ok: false });
    expect(await fail(first.queueId, false)).toEqual({ ok: true, state: 'queued' });
    let row = await t.run((ctx) => ctx.db.get(first.queueId));
    expect(row).toMatchObject({ state: 'queued', dueAt: NOW + queueRetryDelay(1) });
    expect(row?.error?.length).toBeLessThanOrEqual(300);
    expect(await fail(second.queueId, true)).toEqual({ ok: true, state: 'failed' });
    await t.run((ctx) => ctx.db.patch(first.queueId, { attempts: QUEUE_MAX_ATTEMPTS }));
    expect(await fail(first.queueId, false)).toEqual({ ok: true, state: 'failed' });
    row = await t.run((ctx) => ctx.db.get(first.queueId));
    expect(row?.state).toBe('failed');
    // A failed row is not claimed, and the corpus does not queue it again.
    setSystemTime(new Date(NOW + 2 * DAY));
    expect(
      await t.mutation(api.mailAttachments.claimQueue, { internalSecret: SECRET, userId: USER }),
    ).toEqual([]);
    await ingest(t, 'acct', [message('m1', { attachments: [pdf] })]);
    expect(await rows(t, 'mailAttachmentQueue')).toHaveLength(2);
  });

  test('the retry delay grows to one day', () => {
    expect(queueRetryDelay(0)).toBe(15 * 60_000);
    expect(queueRetryDelay(1)).toBe(15 * 60_000);
    expect(queueRetryDelay(2)).toBe(60 * 60_000);
    expect(queueRetryDelay(3)).toBe(4 * 60 * 60_000);
    expect(queueRetryDelay(9)).toBe(DAY);
  });
});

describe('recordFile', () => {
  test('uploads, then links the same bytes of the same user without a second upload', async () => {
    const t = harness();
    await addAccount(t, 'acct');
    await addAccount(t, 'acct2');
    await ingest(t, 'acct', [message('m1')]);
    const file = await upload(t, 'invoice bytes');
    // No stored twin: the app must upload.
    expect(await record(t, 'acct', 'att_pdf', file)).toEqual({ status: 'upload' });
    expect(await record(t, 'acct', 'att_pdf', file, { storageId: file.storageId, size: 1 })).toEqual({
      status: 'stored',
      deduplicated: false,
    });
    const [stored] = await rows(t, 'mailAttachmentFiles');
    // The size comes from storage, and the stored row clears its queue row.
    expect(stored).toMatchObject({ size: file.size, sha256: file.sha256, storageId: file.storageId });
    expect(await rows(t, 'mailAttachmentQueue')).toEqual([]);

    // Another mailbox of the same user with the same bytes shares the file.
    expect(await record(t, 'acct2', 'att_other', file)).toEqual({ status: 'stored', deduplicated: true });
    // A new upload of known bytes is dropped for the twin.
    const again = await upload(t, 'invoice bytes');
    expect(await record(t, 'acct2', 'att_third', again, { storageId: again.storageId })).toEqual({
      status: 'stored',
      deduplicated: true,
    });
    // A second record of a stored key drops its upload.
    const dup = await upload(t, 'invoice bytes');
    expect(await record(t, 'acct', 'att_pdf', dup, { storageId: dup.storageId })).toEqual({
      status: 'stored',
      deduplicated: true,
    });
    expect((await rows(t, 'mailAttachmentFiles')).map((row) => row.storageId)).toEqual([
      file.storageId,
      file.storageId,
      file.storageId,
    ]);
    expect(await blobCount(t)).toBe(1);
  });

  test('refuses bad hashes, missing or mismatched uploads, big files, and mailboxes that are not live', async () => {
    const t = harness();
    await addAccount(t, 'acct');
    await addAccount(t, 'dead', 'error');
    const file = await upload(t, 'bytes');
    await expect(record(t, 'acct', 'a', { ...file, sha256: 'nope' })).rejects.toThrow('hex SHA-256');
    expect(await record(t, 'dead', 'a', file, { storageId: file.storageId })).toEqual({ status: 'skipped' });
    expect(await record(t, 'missing', 'a', file)).toEqual({ status: 'skipped' });
    expect(await blobCount(t)).toBe(0);
    const big = await upload(t, 'big');
    expect(
      await record(
        t,
        'acct',
        'a',
        { ...big, size: ATTACHMENT_STORE_MAX_BYTES + 1 },
        { storageId: big.storageId },
      ),
    ).toEqual({ status: 'too_large' });
    const wrong = await upload(t, 'actual bytes');
    const other = createHash('sha256').update('claimed bytes').digest('hex');
    await expect(
      record(t, 'acct', 'a', { sha256: other, size: 5 }, { storageId: wrong.storageId }),
    ).rejects.toThrow('does not match');
    const gone = await upload(t, 'gone');
    await t.run((ctx) => ctx.storage.delete(gone.storageId));
    await expect(record(t, 'acct', 'a', gone, { storageId: gone.storageId })).rejects.toThrow(
      'not in storage',
    );
    expect(await rows(t, 'mailAttachmentFiles')).toEqual([]);
  });

  test('hexToBase64 gives the storage form of a hash', () => {
    const hash = createHash('sha256').update('abc');
    expect(hexToBase64(hash.copy().digest('hex'))).toBe(hash.digest('base64'));
  });
});

describe('getStoredFile', () => {
  test('resolves the account by id or email, and returns the file or the corpus metadata', async () => {
    const t = harness();
    await addAccount(t, 'acct');
    await ingest(t, 'acct', [message('m1')]);
    const read = (account: string, attachmentId = 'att_pdf', userId = USER, providerMessageId = 'm1') =>
      t.query(api.mailAttachments.getStoredFile, {
        internalSecret: SECRET,
        userId,
        account,
        providerMessageId,
        attachmentId,
      });
    expect(await read('nobody@example.com')).toBeNull();
    expect(await read('   ')).toBeNull();
    expect(await read('acct', 'att_pdf', OTHER)).toBeNull();
    expect(await read('ACCT@example.com')).toEqual({
      accountId: 'acct',
      connected: true,
      file: null,
      corpus: {
        filename: 'Invoice.pdf',
        mimeType: 'application/pdf',
        size: 90_000,
        receivedAt: NOW - DAY,
        labels: ['INBOX'],
      },
    });
    const unknown = await read('grant_acct', 'unknown');
    expect(unknown?.corpus?.receivedAt).toBe(NOW - DAY);
    expect(unknown?.corpus?.filename).toBeUndefined();
    expect(unknown?.corpus?.size).toBeUndefined();
    expect((await read('acct', 'att_pdf', USER, 'no-message'))?.corpus).toBeNull();
    const file = await storeFile(t, 'acct', 'att_pdf', 'invoice bytes');
    const stored = await read('acct');
    expect(stored?.file).toMatchObject({ filename: 'f.pdf', mimeType: 'application/pdf', size: file.size });
    expect(stored?.file?.url).toStartWith('https://');
    expect(stored?.corpus).toBeNull();
  });
});

describe('deletion', () => {
  test('a shared file stays until its last row goes with its mailbox', async () => {
    const t = harness();
    await addAccount(t, 'acct');
    await addAccount(t, 'acct2');
    await storeFile(t, 'acct', 'a1', 'shared bytes');
    await storeFile(t, 'acct2', 'a2', 'shared bytes');
    await storeFile(t, 'acct', 'a3', 'own bytes');
    await ingest(t, 'acct', [message('queued')]);
    await t.mutation(internal.mailAttachments.backfillAccountPage, { userId: USER, accountId: 'acct' });
    expect(await blobCount(t)).toBe(2);

    await t.mutation(api.accounts.deleteConnectedAccount, {
      internalSecret: SECRET,
      userId: USER,
      accountId: 'acct',
    });
    await drain(t);
    const files = await rows(t, 'mailAttachmentFiles');
    expect(files.map((row) => row.accountId)).toEqual(['acct2']);
    expect(await rows(t, 'mailAttachmentQueue')).toEqual([]);
    expect(await rows(t, 'mailAttachmentBackfills')).toEqual([]);
    // The shared file stays for acct2; the file of acct alone is gone.
    expect(await blobCount(t)).toBe(1);

    await t.mutation(api.accounts.deleteConnectedAccount, {
      internalSecret: SECRET,
      userId: USER,
      accountId: 'acct2',
    });
    await drain(t);
    expect(await rows(t, 'mailAttachmentFiles')).toEqual([]);
    expect(await blobCount(t)).toBe(0);
  });

  test('user deletion removes every file row and file', async () => {
    const t = harness();
    await addAccount(t, 'acct');
    await storeFile(t, 'acct', 'a1', 'one');
    await storeFile(t, 'acct', 'a2', 'one');
    await storeFile(t, 'acct', 'a3', 'two');
    await ingest(t, 'acct', [message('queued')]);
    await t.mutation(api.accounts.deleteUserCascade, { internalSecret: SECRET, userId: USER });
    await drain(t);
    expect(await rows(t, 'mailAttachmentFiles')).toEqual([]);
    expect(await rows(t, 'mailAttachmentQueue')).toEqual([]);
    expect(await blobCount(t)).toBe(0);
  });

  test('the dead-account purge deletes the files of the dead mailbox', async () => {
    const t = harness();
    await addAccount(t, 'acct');
    await addAccount(t, 'dead', 'error');
    await storeFile(t, 'acct', 'a1', 'shared');
    await t.run(async (ctx) => {
      const live = await ctx.db.query('mailAttachmentFiles').first();
      await ctx.db.insert('mailAttachmentFiles', {
        ...live!,
        _id: undefined,
        _creationTime: undefined,
        accountId: 'dead',
      } as any);
      await ctx.db.insert('mailAttachmentBackfills', {
        userId: USER,
        accountId: 'dead',
        queued: 0,
        doneAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      });
    });
    const dead = await upload(t, 'dead only');
    await t.run((ctx) =>
      ctx.db.insert('mailAttachmentFiles', {
        userId: USER,
        accountId: 'dead',
        providerMessageId: 'm9',
        attachmentId: 'a9',
        filename: 'x',
        mimeType: 'x',
        size: dead.size,
        sha256: dead.sha256,
        storageId: dead.storageId,
        createdAt: NOW,
      }),
    );
    expect(await blobCount(t)).toBe(2);
    await t.mutation(internal.deadAccounts.purgeDeadAccountBatch, { userId: USER, accountId: 'dead' });
    await drain(t);
    const files = await rows(t, 'mailAttachmentFiles');
    expect(files.map((row) => row.accountId)).toEqual(['acct']);
    expect(await rows(t, 'mailAttachmentBackfills')).toEqual([]);
    expect(await blobCount(t)).toBe(1);
  });

  test('a deleted message or thread takes its files and queue rows', async () => {
    const t = harness();
    await addAccount(t, 'acct');
    await ingest(t, 'acct', [message('m1'), message('m2', { providerThreadId: 'thread_x' })]);
    await storeFile(t, 'acct', 'att_pdf', 'm1 bytes', 'm1');
    await t.mutation(api.mailCorpus.deleteCorpusMessage, {
      internalSecret: SECRET,
      userId: USER,
      accountId: 'acct',
      providerMessageId: 'm1',
    });
    expect(await rows(t, 'mailAttachmentFiles')).toEqual([]);
    expect(await blobCount(t)).toBe(0);
    expect((await rows(t, 'mailAttachmentQueue')).map((row) => row.providerMessageId)).toEqual(['m2']);
    await storeFile(t, 'acct', 'att_other', 'm2 bytes', 'm2');
    await t.mutation(api.mailCorpus.deleteCorpusThread, {
      internalSecret: SECRET,
      userId: USER,
      accountId: 'acct',
      providerThreadId: 'thread_x',
    });
    expect(await rows(t, 'mailAttachmentQueue')).toEqual([]);
    expect(await rows(t, 'mailAttachmentFiles')).toEqual([]);
    expect(await blobCount(t)).toBe(0);
  });
});

async function seedCorpus(t: T, accountId: string, count: number, receivedAt: (i: number) => number) {
  await t.run(async (ctx) => {
    for (let i = 0; i < count; i++)
      await ctx.db.insert('mailCorpusMessages', {
        userId: USER,
        accountId,
        grantId: `grant_${accountId}`,
        provider: 'google',
        providerMessageId: `seed_${i}`,
        providerThreadId: `seed_t_${i}`,
        subject: 's',
        from: 'a@example.com',
        to: 'me@example.com',
        receivedAt: receivedAt(i),
        snippet: 's',
        searchText: 's',
        labels: ['INBOX'],
        attachments: i % 2 === 0 ? [{ ...pdf, attachmentId: `att_${i}` }] : [],
        yearMonth: '2026-09',
        createdAt: NOW,
        updatedAt: NOW,
      });
  });
}

describe('backfill of stored mail', () => {
  test('pages the window newest first, keeps the cursor, and stops at old mail', async () => {
    const t = harness();
    await addAccount(t, 'acct');
    await addAccount(t, 'dead', 'error');
    const inWindow = BACKFILL_PAGE + 10;
    await seedCorpus(t, 'acct', inWindow + 4, (i) => (i < inWindow ? NOW - i * 60_000 : NOW - 90 * DAY - i));
    expect(await t.query(internal.mailAttachments.backfillAccounts, {})).toEqual([
      { userId: USER, accountId: 'acct' },
    ]);
    const first = await t.mutation(internal.mailAttachments.backfillAccountPage, {
      userId: USER,
      accountId: 'acct',
    });
    expect(first).toEqual({ done: false, queued: BACKFILL_PAGE / 2 });
    const [state] = await rows(t, 'mailAttachmentBackfills');
    expect(state.cursor).toBeString();
    expect(state.doneAt).toBeUndefined();
    const second = await t.mutation(internal.mailAttachments.backfillAccountPage, {
      userId: USER,
      accountId: 'acct',
    });
    expect(second).toEqual({ done: true, queued: 5 });
    const [done] = await rows(t, 'mailAttachmentBackfills');
    expect(done).toMatchObject({ doneAt: NOW, queued: BACKFILL_PAGE / 2 + 5 });
    expect(done.cursor).toBeUndefined();
    expect(await rows(t, 'mailAttachmentQueue')).toHaveLength(inWindow / 2);
    expect(await t.query(internal.mailAttachments.backfillAccounts, {})).toEqual([]);
    expect(
      await t.mutation(internal.mailAttachments.backfillAccountPage, { userId: USER, accountId: 'acct' }),
    ).toEqual({ done: true, queued: 0 });
    // A mailbox that is not live does not move.
    expect(
      await t.mutation(internal.mailAttachments.backfillAccountPage, { userId: USER, accountId: 'dead' }),
    ).toEqual({ done: false, queued: 0 });
  });

  test('a short corpus finishes in one page', async () => {
    const t = harness();
    await addAccount(t, 'acct');
    await seedCorpus(t, 'acct', 3, () => NOW - DAY);
    expect(
      await t.mutation(internal.mailAttachments.backfillAccountPage, { userId: USER, accountId: 'acct' }),
    ).toEqual({ done: true, queued: 2 });
  });
});

describe('the tick', () => {
  test('does nothing without the app URL', async () => {
    const t = harness();
    delete process.env.LAB86_MAIL_PUBLIC_URL;
    expect(await t.action(internal.mailAttachments.tick, {})).toEqual({
      backfilled: 0,
      queued: 0,
      users: 0,
      started: 0,
    });
  });

  test('moves the backfill and asks the app to serve each user with due work', async () => {
    const t = harness();
    process.env.LAB86_MAIL_PUBLIC_URL = 'https://mail.example.test/';
    await addAccount(t, 'acct');
    await addAccount(t, 'other', 'connected', OTHER);
    await seedCorpus(t, 'acct', 2, () => NOW - DAY);
    const calls: Array<{ url: string; body: unknown; secret: string | null }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: any, init: any) => {
      calls.push({
        url: String(url),
        body: JSON.parse(init.body),
        secret: new Headers(init.headers).get('x-lab86-internal-secret'),
      });
      return new Response(null, { status: 202 });
    }) as any;
    try {
      expect(await t.action(internal.mailAttachments.tick, {})).toEqual({
        backfilled: 2,
        queued: 1,
        users: 1,
        started: 1,
      });
      expect(calls).toEqual([
        {
          url: 'https://mail.example.test/api/cron/mail-attachments',
          body: { userId: USER },
          secret: SECRET,
        },
      ]);
      expect(await t.query(internal.mailAttachments.usersWithDueWork, { now: NOW - 1 })).toEqual([]);
      // With no due work the app is not called.
      await t.mutation(api.mailAttachments.claimQueue, { internalSecret: SECRET, userId: USER });
      calls.length = 0;
      expect((await t.action(internal.mailAttachments.tick, {})).started).toBe(0);
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.LAB86_MAIL_PUBLIC_URL;
    }
  });

  test('uploadUrl needs the internal secret', async () => {
    const t = harness();
    expect(await t.mutation(api.mailAttachments.uploadUrl, { internalSecret: SECRET })).toStartWith(
      'https://',
    );
    await expect(t.mutation(api.mailAttachments.uploadUrl, { internalSecret: 'wrong' })).rejects.toThrow();
  });
});

// Type use, so an Id import error shows at compile time.
export type _QueueId = Id<'mailAttachmentQueue'>;
