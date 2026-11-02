import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api } from '../convex/_generated/api';
import schema from '../convex/schema';

const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/userData.ts': () => import('../convex/userData'),
  '../convex/briefJobs.ts': () => import('../convex/briefJobs'),
  '../convex/briefJobState.ts': () => import('../convex/briefJobState'),
  '../convex/lib.ts': () => import('../convex/lib'),
};
const secret = 'brief-read-test';
let previous: string | undefined;
beforeAll(() => {
  previous = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = secret;
});
afterAll(() => {
  if (previous === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previous;
});
const args = { internalSecret: secret, userId: 'reader', cursor: null, limit: 1, summaryOnly: false };

describe('the small reads of the web page', () => {
  const job = (patch: Record<string, unknown>) => ({
    userId: 'reader',
    scope: 'daily:2026-11-02',
    kind: 'daily' as const,
    edition: 'manual' as const,
    reportId: 'new',
    state: 'running' as const,
    active: true,
    availableAt: 1,
    createdAt: 10,
    attempts: 1,
    ...patch,
  });
  const reader = { internalSecret: secret, userId: 'reader' };

  test('no active daily job is null, and it reads no edition', async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert('briefJobs', job({ kind: 'narrative', reportId: undefined }));
      await ctx.db.insert('briefJobs', job({ active: false, state: 'completed' }));
      await ctx.db.insert('briefJobs', job({ userId: 'someone-else' }));
    });
    expect(await t.query(api.briefJobs.activeEdition, reader)).toBeNull();
    await expect(
      t.query(api.briefJobs.activeEdition, { ...reader, internalSecret: 'wrong' }),
    ).rejects.toThrow();
  });

  test('the newest active daily job gives the state of its row', async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert('briefJobs', job({ reportId: 'older', createdAt: 5 }));
      await ctx.db.insert('briefJobs', job({}));
      await ctx.db.insert('userDocs', {
        userId: 'reader',
        kind: 'dailyReport',
        key: 'new',
        createdAt: 10,
        updatedAt: 10,
        doc: {
          status: 'ready',
          artifactStatus: 'composing',
          retrying: true,
          progress: { stage: 'Mail', done: 1, total: 2 },
          sections: { large: 'x'.repeat(1000) },
        },
      });
    });
    expect(await t.query(api.briefJobs.activeEdition, reader)).toEqual({
      reportId: 'new',
      status: 'ready',
      artifactStatus: 'composing',
      retrying: true,
      progress: { stage: 'Mail', done: 1, total: 2 },
    });
  });

  test('a job before its row exists reads as a placeholder', async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert('briefJobs', job({}));
    });
    expect(await t.query(api.briefJobs.activeEdition, reader)).toEqual({
      reportId: 'new',
      status: 'partial',
      artifactStatus: null,
      retrying: false,
      progress: null,
    });
  });

  test('getDocs reads the named rows of one owner, and caps the batch', async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (const [userId, key] of [
        ['reader', 'a'],
        ['reader', 'b'],
        ['someone-else', 'c'],
      ])
        await ctx.db.insert('userDocs', {
          userId,
          kind: 'trackedThread',
          key,
          createdAt: 1,
          updatedAt: 1,
          doc: { _id: key },
        });
    });
    const rows = await t.query(api.userData.getDocs, {
      ...reader,
      kind: 'trackedThread',
      keys: ['a', 'c', 'missing'],
    });
    expect(rows.map((row) => row.key)).toEqual(['a']);
    const beyond = await t.query(api.userData.getDocs, {
      ...reader,
      kind: 'trackedThread',
      keys: [...Array.from({ length: 100 }, (_, index) => `x${index}`), 'b'],
    });
    expect(beyond).toEqual([]);
  });
});

describe('bounded brief reads', () => {
  test('indexes existing nested payloads by generation time, edition, and owner', async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (const [userId, key, generatedAt, updatedAt, kind] of [
        ['reader', 'older-edited', 100, 900, 'morning'],
        ['reader', 'latest', 300, 300, 'manual'],
        ['reader', 'morning', 200, 200, 'morning'],
        ['someone-else', 'private', 1000, 1000, 'manual'],
      ] as const)
        await ctx.db.insert('userDocs', {
          userId,
          kind: 'dailyReport',
          key,
          createdAt: generatedAt,
          updatedAt,
          doc: { _id: key, kind, generatedAt, title: key },
        });
    });
    const result = await t.query(api.userData.dailyReportPage, args);
    expect(result.page.map((r) => r._id)).toEqual(['latest']);
    expect((await t.query(api.userData.dailyReportPage, { ...args, edition: 'morning' })).page[0]._id).toBe(
      'morning',
    );
    expect((await t.query(api.userData.dailyReportPage, { ...args, userId: 'empty' })).page).toEqual([]);
    await expect(
      t.query(api.userData.dailyReportPage, { ...args, internalSecret: 'wrong' }),
    ).rejects.toThrow();
  });

  test('the latest weekly review is read by its edition', async () => {
    // get_latest_daily_report accepts kind 'weekly'; the read used to fail argument validation.
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (const [key, generatedAt, kind] of [
        ['weekly-old', 100, 'weekly'],
        ['weekly-new', 200, 'weekly'],
        ['manual-latest', 300, 'manual'],
      ] as const)
        await ctx.db.insert('userDocs', {
          userId: 'reader',
          kind: 'dailyReport',
          key,
          createdAt: generatedAt,
          updatedAt: generatedAt,
          doc: { _id: key, kind, generatedAt, title: key },
        });
    });
    const result = await t.query(api.userData.dailyReportPage, { ...args, edition: 'weekly' });
    expect(result.page.map((r) => r._id)).toEqual(['weekly-new']);
  });

  test('a history larger than the read limit is paged without returning artifact bodies in summaries', async () => {
    const t = convexTest(schema, modules);
    const html = 'x'.repeat(750_000);
    for (let i = 0; i < 24; i++)
      await t.run((ctx) =>
        ctx.db.insert('userDocs', {
          userId: 'reader',
          kind: 'dailyReport',
          key: `report-${i}`,
          createdAt: i,
          updatedAt: 100 - i,
          doc: {
            _id: `report-${i}`,
            kind: 'morning',
            generatedAt: i,
            title: `Edition ${i}`,
            html,
            artifactStatus: 'ready',
            editorial: { mode: 'generated', plan: { large: 'p'.repeat(5_000) } },
          },
        }),
      );
    let cursor: string | null = null;
    const ids: string[] = [];
    let done = false;
    while (!done) {
      const result: { page: any[]; continueCursor: string; isDone: boolean } = await t.query(
        api.userData.dailyReportPage,
        {
          ...args,
          cursor,
          limit: 1000,
          summaryOnly: true,
        },
      );
      expect(result.page.length).toBeLessThanOrEqual(8);
      expect(JSON.stringify(result.page).length).toBeLessThan(2000);
      expect(result.page.every((r) => !('html' in r))).toBe(true);
      expect(result.page[0].editorial).toEqual({ mode: 'generated' });
      expect(result.page[0].artifactStatus).toBe('ready');
      ids.push(...result.page.map((r) => r._id));
      cursor = result.continueCursor;
      done = result.isDone;
    }
    expect(ids).toEqual(Array.from({ length: 24 }, (_, i) => `report-${23 - i}`));
    expect((await t.query(api.userData.dailyReportPage, args)).page[0].html).toHaveLength(750_000);
  });
});

test('existing generic store operations preserve edition ownership and do not overwrite create-if-absent records', async () => {
  const t = convexTest(schema, modules);
  const base = { internalSecret: secret, userId: 'reader', kind: 'dailyReport', key: 'edition' };
  expect(await t.query(api.userData.getDoc, base)).toBeNull();
  expect(
    (await t.mutation(api.userData.createDocIfAbsent, { ...base, ref: 'morning', doc: { generatedAt: 1 } }))
      .created,
  ).toBe(true);
  expect(
    (await t.mutation(api.userData.createDocIfAbsent, { ...base, doc: { generatedAt: 2 } })).doc.generatedAt,
  ).toBe(1);
  expect(
    (await t.mutation(api.userData.upsertDoc, { ...base, ref: 'morning', doc: { generatedAt: 3 } })).created,
  ).toBe(false);
  expect(
    (
      await t.mutation(api.userData.upsertDoc, {
        ...base,
        key: 'second',
        ref: 'evening',
        doc: { generatedAt: 4 },
      })
    ).created,
  ).toBe(true);
  expect((await t.query(api.userData.getDoc, base))?.doc.generatedAt).toBe(3);
  const owner = { internalSecret: secret, userId: 'reader', kind: 'dailyReport' };
  expect((await t.query(api.userData.listDocs, owner)).map((r) => r.key).sort()).toEqual([
    'edition',
    'second',
  ]);
  expect((await t.query(api.userData.listDocs, { ...owner, ref: 'morning', limit: 1 }))[0].key).toBe(
    'edition',
  );
  expect(await t.query(api.userData.listDocs, { ...owner, userId: 'other' })).toEqual([]);
  expect((await t.mutation(api.userData.deleteDoc, { ...base, userId: 'other' })).deleted).toBe(false);
  expect((await t.mutation(api.userData.deleteDoc, { ...base, key: 'second' })).deleted).toBe(true);
  expect((await t.mutation(api.userData.deleteDocs, { ...owner, ref: 'morning', limit: 1 })).deleted).toBe(1);
  await t.mutation(api.userData.upsertDoc, { ...base, doc: { generatedAt: 5 } });
  expect((await t.mutation(api.userData.deleteDocs, owner)).deleted).toBe(1);
});
