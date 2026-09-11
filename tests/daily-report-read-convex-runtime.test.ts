import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api } from '../convex/_generated/api';
import schema from '../convex/schema';

const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/userData.ts': () => import('../convex/userData'),
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
          doc: { _id: `report-${i}`, kind: 'morning', generatedAt: i, title: `Edition ${i}`, html },
        }),
      );
    let cursor: string | null = null;
    const ids: string[] = [];
    let done = false;
    while (!done) {
      const result = await t.query(api.userData.dailyReportPage, {
        ...args,
        cursor,
        limit: 1000,
        summaryOnly: true,
      });
      expect(result.page.length).toBeLessThanOrEqual(8);
      expect(JSON.stringify(result.page).length).toBeLessThan(2000);
      expect(result.page.every((r) => !('html' in r))).toBe(true);
      ids.push(...result.page.map((r) => r._id));
      cursor = result.continueCursor;
      done = result.isDone;
    }
    expect(ids).toEqual(Array.from({ length: 24 }, (_, i) => `report-${23 - i}`));
    expect((await t.query(api.userData.dailyReportPage, args)).page[0].html).toHaveLength(750_000);
  });
});
