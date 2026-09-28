import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { convexTest, type TestConvex } from 'convex-test';
import { api, internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import {
  ACCOUNT_KEYED_ROWS,
  CONTENT_ITEM_BYTES,
  PURGE_PASS_BYTES,
  PURGE_ROW_BYTES,
  purgePassRoom,
  storedBytes,
} from '../convex/accounts';
import schema from '../convex/schema';

// Convex stops a mutation that reads more than 16 MiB (or writes more than
// 16 MiB), and a stopped purge pass does not schedule the next one. These
// tests seed rows near their size bounds, run each purge chain one pass at a
// time, and check that every pass stays within PURGE_PASS_BYTES (8 MiB) and
// that the chain still deletes everything.

const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/accounts.ts': () => import('../convex/accounts'),
  '../convex/correspondents.ts': () => import('../convex/correspondents'),
  '../convex/deadAccounts.ts': () => import('../convex/deadAccounts'),
  '../convex/narrative.ts': () => import('../convex/narrative'),
};
const SECRET = 'account-purge-limits-secret';
const USER = 'user_limits';
const GONE = 'grant_big';
const KEPT = 'grant_kept';
const T0 = Date.UTC(2026, 8, 1);
const KiB = 1024;
// '€' is 3 bytes in UTF-8, so these strings reach the byte bounds with the
// character limits of the writers.
const wide = (chars: number) => '€'.repeat(chars);
const vector = () => Array.from({ length: 1536 }, (_, index) => index / 1536 + 0.123456789);

let previousSecret: string | undefined;
beforeAll(() => {
  previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
});

type T = TestConvex<typeof schema>;

async function insertItem(t: T, account: string, key: string, chunks: number) {
  return t.run(async (ctx) => {
    const itemId = await ctx.db.insert('contentItems', {
      userId: USER,
      key,
      connectionId: account,
      source: 'mail',
      externalId: key,
      title: wide(500),
      text: wide(120_000),
      version: 'v1',
      modifiedAt: T0,
      indexedAt: T0,
      partial: false,
      deleted: false,
      status: 'ready',
      attempts: 1,
      nextAttemptAt: 0,
    });
    for (let chunk = 0; chunk < chunks; chunk++)
      await ctx.db.insert('contentChunks', {
        userId: USER,
        itemId,
        version: 'v1',
        text: wide(4000),
        embedding: vector(),
      });
    return itemId;
  });
}

describe('the size estimate and the pass room', () => {
  test('storedBytes counts UTF-8 text, numbers, arrays, objects, and binary data', () => {
    expect(storedBytes('abc')).toBe(7);
    expect(storedBytes('€')).toBe(7);
    expect(storedBytes('é')).toBe(6);
    // Each half of a surrogate pair counts 3 bytes.
    expect(storedBytes('😀')).toBe(10);
    expect(storedBytes(1.5)).toBe(9);
    expect(storedBytes(null)).toBe(9);
    expect(storedBytes(true)).toBe(9);
    expect(storedBytes([1, 'a'])).toBe(4 + 9 + 5);
    expect(storedBytes({ a: 1 })).toBe(4 + 1 + 2 + 9);
    expect(storedBytes(new ArrayBuffer(10))).toBe(14);
    // A vector chunk counts 9 bytes a number: more than its 8 stored bytes.
    expect(storedBytes(vector())).toBe(4 + 1536 * 9);
  });

  test('purgePassRoom keeps the reads of a pass within the row and byte room', () => {
    expect(purgePassRoom({ rows: 0, bytes: 0 }, 1024 * KiB, 250)).toBe(8);
    expect(purgePassRoom({ rows: 0, bytes: 0 }, 16 * KiB, 250)).toBe(250);
    expect(purgePassRoom({ rows: 0, bytes: 0 }, 16 * KiB, 40)).toBe(40);
    expect(purgePassRoom({ rows: 245, bytes: 0 }, 16 * KiB, 250)).toBe(5);
    expect(purgePassRoom({ rows: 0, bytes: PURGE_PASS_BYTES - 1 }, 16 * KiB, 250)).toBe(0);
    expect(purgePassRoom({ rows: 0, bytes: PURGE_PASS_BYTES + 5 }, 16 * KiB, 250)).toBe(0);
  });

  test('every row bound fits one pass, so a pass always takes a row', () => {
    for (const bytes of [
      ...Object.values(PURGE_ROW_BYTES),
      ...ACCOUNT_KEYED_ROWS.map((entry) => entry.rowBytes),
    ])
      expect(purgePassRoom({ rows: 0, bytes: 0 }, bytes, 250)).toBeGreaterThan(0);
    // A preparations pass reads its page (at most 3 MiB) and then one item or more.
    expect(3 * 1024 * KiB + CONTENT_ITEM_BYTES).toBeLessThan(PURGE_PASS_BYTES);
  });
});

describe('a purge of large rows runs in passes within the byte room', () => {
  test('large message caches, drafts, webhook rows, and content items drain in several passes', async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      // Message caches at the writer limits: 64,000 text and 200,000 HTML characters.
      for (let index = 0; index < 20; index++)
        await ctx.db.insert('userDocs', {
          userId: USER,
          kind: 'msgCache',
          key: `${GONE}:m${index}`,
          ref: `${GONE}:t${index}`,
          doc: { account: GONE, textBody: wide(64_000), htmlBody: wide(200_000) },
          createdAt: T0,
          updatedAt: T0,
        });
      // Drafts have no size limit other than the document limit.
      for (let index = 0; index < 10; index++)
        await ctx.db.insert('userDocs', {
          userId: USER,
          kind: 'draft',
          key: `draft-${index}`,
          ref: GONE,
          doc: { account: GONE, body: wide(300_000) },
          createdAt: T0,
          updatedAt: T0,
        });
      // Webhook rows from before the ids-only change keep their payload.
      for (let index = 0; index < 12; index++)
        await ctx.db.insert('mailWebhookEvents', {
          eventId: `w${index}`,
          type: 'message.created',
          userId: USER,
          accountId: GONE,
          payload: { body: wide(150_000) },
          status: 'processed',
          receivedAt: T0,
        });
    });
    for (let index = 0; index < 8; index++) await insertItem(t, GONE, `mail:${GONE}:t${index}`, 34);
    const seeded = await t.run(async (ctx) =>
      storedBytes([
        ...(await ctx.db.query('userDocs').collect()),
        ...(await ctx.db.query('mailWebhookEvents').collect()),
        ...(await ctx.db.query('contentItems').collect()),
        ...(await ctx.db.query('contentChunks').collect()),
      ]),
    );
    expect(seeded).toBeGreaterThan(32 * 1024 * KiB);

    const passes: Array<{ deleted: number; bytes: number }> = [];
    for (let pass = 0; pass < 60; pass++) {
      const result: any = await t.mutation(internal.accounts.purgeAccountDataBatch, {
        userId: USER,
        accountId: GONE,
      });
      passes.push({ deleted: result.deleted, bytes: result.bytes });
      if (result.done) break;
    }
    expect(passes.at(-1)?.deleted).toBe(0);
    expect(passes.length).toBeGreaterThan(5);
    for (const pass of passes) expect(pass.bytes).toBeLessThanOrEqual(PURGE_PASS_BYTES);
    // The passes counted every byte that they read.
    expect(passes.reduce((sum, pass) => sum + pass.bytes, 0)).toBeGreaterThanOrEqual(seeded);
    const left = await t.run(async (ctx) => ({
      docs: (await ctx.db.query('userDocs').collect()).length,
      webhooks: (await ctx.db.query('mailWebhookEvents').collect()).length,
      items: (await ctx.db.query('contentItems').collect()).length,
      chunks: (await ctx.db.query('contentChunks').collect()).length,
    }));
    expect(left).toEqual({ docs: 0, webhooks: 0, items: 0, chunks: 0 });
  }, 60_000);

  test('the dead-account purge uses the same room and stops only when done', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.accounts.upsertConnectedAccount, {
      internalSecret: SECRET,
      userId: USER,
      email: 'big@example.com',
      provider: 'google',
      grantId: GONE,
      scopes: [],
    });
    await t.mutation(api.accounts.markGrantReconnectNeeded, {
      internalSecret: SECRET,
      grantId: GONE,
      reason: 'x',
    });
    await t.run(async (ctx) => {
      for (let index = 0; index < 12; index++)
        await ctx.db.insert('userDocs', {
          userId: USER,
          kind: 'msgCache',
          key: `${GONE}:m${index}`,
          doc: { textBody: wide(64_000), htmlBody: wide(200_000) },
          createdAt: T0,
          updatedAt: T0,
        });
    });
    const passes: number[] = [];
    for (let pass = 0; pass < 20; pass++) {
      const result: any = await t.mutation(internal.deadAccounts.purgeDeadAccountBatch, {
        userId: USER,
        accountId: GONE,
      });
      passes.push(result.bytes);
      if (result.done) break;
    }
    expect(passes.length).toBeGreaterThan(2);
    for (const bytes of passes) expect(bytes).toBeLessThanOrEqual(PURGE_PASS_BYTES);
    expect(await t.run(async (ctx) => (await ctx.db.query('userDocs').collect()).length)).toBe(0);
  }, 60_000);

  test('the whole-user purge also stays within the room', async () => {
    const t = convexTest(schema, modules);
    for (let index = 0; index < 8; index++) await insertItem(t, KEPT, `mail:${KEPT}:t${index}`, 34);
    await t.run(async (ctx) => {
      for (let index = 0; index < 6; index++)
        await ctx.db.insert('mailCorpusBodies', {
          userId: USER,
          accountId: KEPT,
          providerMessageId: `m${index}`,
          providerThreadId: 't',
          textBody: wide(32_000),
          htmlBody: wide(200_000),
          createdAt: T0,
          updatedAt: T0,
        });
    });
    const passes: number[] = [];
    for (let pass = 0; pass < 30; pass++) {
      const result = await t.mutation(internal.accounts.purgeUserDataBatch, { userId: USER });
      passes.push(result.bytes);
      if (result.deleted === 0) break;
    }
    expect(passes.length).toBeGreaterThan(2);
    for (const bytes of passes) expect(bytes).toBeLessThanOrEqual(PURGE_PASS_BYTES);
    const left = await t.run(async (ctx) => ({
      items: (await ctx.db.query('contentItems').collect()).length,
      chunks: (await ctx.db.query('contentChunks').collect()).length,
      bodies: (await ctx.db.query('mailCorpusBodies').collect()).length,
    }));
    expect(left).toEqual({ items: 0, chunks: 0, bodies: 0 });
  }, 60_000);
});

describe('the preparation check resumes across passes', () => {
  test('many preparations with 21 large content items each are checked within the room', async () => {
    const t = convexTest(schema, modules);
    const items: Id<'contentItems'>[] = [];
    for (let index = 0; index < 21; index++)
      items.push(await insertItem(t, KEPT, `mail:${KEPT}:k${index}`, 0));
    // An id whose item is gone, as after a purge.
    const lostItem = await insertItem(t, GONE, `mail:${GONE}:lost`, 0);
    await t.run((ctx) => ctx.db.delete(lostItem));
    await t.run(async (ctx) => {
      const prepare = (key: string, sources: Id<'contentItems'>[]) =>
        ctx.db.insert('briefPreparations', {
          userId: USER,
          key,
          seedId: items[0],
          seedVersion: 'v1',
          status: 'resolved',
          draft: { title: 'x' },
          sources: sources.map((id) => ({ _id: id, version: 'v1' })),
          userNotes: '',
          revision: 1,
          nextAttemptAt: 0,
          needsRefresh: false,
          createdAt: T0,
          updatedAt: T0,
        });
      for (let index = 0; index < 9; index++) {
        // Every third preparation lost its last source; the check reads the other 20 first.
        const lost = index % 3 === 2;
        await prepare(`prep-${index}`, [...items.slice(1, 20), lost ? lostItem : items[20]]);
      }
    });
    const itemBytes = await t.run(async (ctx) => storedBytes(await ctx.db.get(items[1])));
    expect(itemBytes).toBeGreaterThan(350 * KiB);
    expect(itemBytes).toBeLessThanOrEqual(CONTENT_ITEM_BYTES);

    let args: any = { userId: USER, accountId: GONE, step: 2, cursor: null };
    const passes: number[] = [];
    let deleted = 0;
    for (let pass = 0; pass < 80; pass++) {
      const result: any = await t.mutation(internal.accounts.purgeAccountDerivedRows, args);
      passes.push(result.bytes);
      deleted += result.deleted;
      if (result.done || result.next.step !== 2) break;
      args = result.next;
    }
    // 9 preparations × 21 items × about 360 kB is about 68 MB of reads.
    expect(passes.length).toBeGreaterThan(8);
    for (const bytes of passes) expect(bytes).toBeLessThanOrEqual(PURGE_PASS_BYTES);
    expect(deleted).toBe(3);
    const keys = await t.run(async (ctx) =>
      (await ctx.db.query('briefPreparations').collect()).map((row) => row.key).sort(),
    );
    expect(keys).toEqual(['prep-0', 'prep-1', 'prep-3', 'prep-4', 'prep-6', 'prep-7']);
  }, 60_000);

  test('a pass that resumes at a deleted row starts that page again', async () => {
    const t = convexTest(schema, modules);
    const item = await insertItem(t, KEPT, `mail:${KEPT}:one`, 0);
    const ids = await t.run(async (ctx) => {
      const prepare = (key: string) =>
        ctx.db.insert('briefPreparations', {
          userId: USER,
          key,
          seedId: item,
          seedVersion: 'v1',
          status: 'resolved',
          sources: [],
          userNotes: '',
          revision: 1,
          nextAttemptAt: 0,
          needsRefresh: false,
          createdAt: T0,
          updatedAt: T0,
        });
      const gone = await prepare('a');
      await prepare('b');
      await ctx.db.delete(gone);
      return { gone };
    });
    const result: any = await t.mutation(internal.accounts.purgeAccountDerivedRows, {
      userId: USER,
      accountId: GONE,
      step: 2,
      cursor: null,
      resumeId: ids.gone,
      position: 5,
    });
    expect(result).toMatchObject({ deleted: 0, done: false });
    expect(result.next).toMatchObject({ step: 3, cursor: null });
    expect(await t.run(async (ctx) => (await ctx.db.query('briefPreparations').collect()).length)).toBe(1);
  });
});
