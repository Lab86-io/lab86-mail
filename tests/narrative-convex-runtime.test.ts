import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api, internal } from '../convex/_generated/api';
import schema from '../convex/schema';

const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/narrative.ts': () => import('../convex/narrative'),
};
const f = (api as any).narrative;
const secret = 'narrative-runtime-secret',
  userId = 'narrative_user';
const args = { internalSecret: secret, userId };
let previous: string | undefined;
beforeAll(() => {
  previous = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = secret;
});
afterAll(() => {
  if (previous === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previous;
});
function harness() {
  return convexTest(schema, modules);
}
async function enable(t: ReturnType<typeof harness>, sources = ['chat', 'work', 'checkins', 'areas']) {
  await t.mutation(f.configure, {
    ...args,
    enabled: true,
    sources,
    timezone: 'America/New_York',
    model: 'z-ai/glm-5.3-flash',
  });
  await t.finishAllScheduledFunctions(() => {});
}
async function capture(
  t: ReturnType<typeof harness>,
  text = 'Tomorrow I want to ship the launch',
  messageId = 'm1',
) {
  return t.mutation(f.captureTurn, { ...args, messageId, text, topics: ['work:launch'] });
}
describe('shared narrative runtime', () => {
  test('corrections block replay of an old source version without freezing future changes', async () => {
    const t = harness();
    await enable(t);
    const source = await t.run((ctx) =>
      ctx.db.insert('albatrossIntents', {
        userId,
        rawText: 'Ship review',
        source: 'text',
        status: 'captured',
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    await t.mutation(f.ingest, { ...args, group: 'work' });
    const old = (await t.query(f.search, { ...args, level: 'observation' })).entries[0];
    await t.mutation(f.edit, { ...args, id: old._id, text: 'Wait for QA before shipping' });
    await t.run(async (ctx) => {
      const cursors = await ctx.db.query('narrativeCursors').collect();
      for (const cursor of cursors) await ctx.db.delete(cursor._id);
    });
    await t.mutation(f.ingest, { ...args, group: 'work' });
    expect((await t.query(f.search, { ...args, level: 'observation' })).entries[0].text).toBe(
      'Wait for QA before shipping',
    );
    await t.run((ctx) =>
      ctx.db.patch(source, { rawText: 'QA passed; prepare deployment', updatedAt: Date.now() }),
    );
    await t.mutation(f.ingest, { ...args, group: 'work' });
    expect((await t.query(f.search, { ...args, level: 'observation' })).entries[0].text).toContain(
      'QA passed',
    );
    const historical = await t.query(f.read, { ...args, id: old._id });
    expect(historical.entry.current).toBe(false);
    expect(historical.entry.text).toBe('Wait for QA before shipping');
  });
  test('old unfinished work survives a large history of pinned derived chapters', async () => {
    const t = harness();
    await enable(t);
    const old = await capture(t, 'Finish the long-running review', 'long-running');
    await t.run(async (ctx) => {
      await ctx.db.patch(old, { occurredAt: 1, pinned: true });
      for (let i = 0; i < 210; i++)
        await ctx.db.insert('narrativeEntries', {
          userId,
          key: `historic:${i}`,
          level: 'day',
          title: 'An old chapter',
          text: 'A past account',
          source: 'derived',
          sourceIds: [old],
          topics: [],
          trust: 'inferred',
          occurredAt: Date.now() - i,
          observedAt: Date.now(),
          updatedAt: Date.now(),
          current: true,
          pinned: true,
        });
    });
    expect(
      (await t.query(f.search, { ...args, query: 'long-running', level: 'observation' })).entries.some(
        (e: any) => e._id === old,
      ),
    ).toBe(true);
    await t.mutation(f.prepareBrief, args);
    expect((await t.query(f.brief, args)).entry.sourceIds).toContain(old);
  });
  test('correction preserves unrelated historical chapters and recompilation resets stale model labels', async () => {
    const t = harness();
    await enable(t);
    const older = await capture(t, 'The old project is ready', 'older');
    await t.run((ctx) => ctx.db.patch(older, { occurredAt: 1, topics: ['work:old'] }));
    await t.mutation(f.compile, args);
    const oldChapter = (await t.query(f.search, { ...args, level: 'month', to: 1000 })).entries[0];
    const current = await capture(t, 'The new project needs review', 'current');
    await t.mutation(f.compile, args);
    const chapter = (await t.query(f.search, { ...args, level: 'day', from: Date.now() - 86400000 }))
      .entries[0];
    const revision = (await t.query(f.read, { ...args, id: chapter._id })).revision;
    await t.mutation(f.publish, {
      ...args,
      revision,
      id: chapter._id,
      text: 'A model chapter',
      model: 'test',
    });
    await capture(t, 'QA is still running', 'new');
    await t.mutation(f.compile, args);
    expect((await t.query(f.read, { ...args, id: chapter._id })).entry.model).toBeUndefined();
    await t.mutation(f.edit, { ...args, id: current, text: 'The current plan changed' });
    expect((await t.query(f.read, { ...args, id: oldChapter._id })).entry._id).toBe(oldChapter._id);
  });
  test('a brief includes yesterday, reports evidence, and disappears immediately after a correction', async () => {
    const t = harness();
    await enable(t);
    const id = await capture(t);
    const brief = await t.mutation(f.prepareBrief, args);
    expect((await t.query(f.brief, args)).entry._id).toBe(brief);
    await t.mutation(f.edit, { ...args, id, text: 'That is no longer the plan' });
    expect((await t.query(f.brief, args)).entry).toBeNull();
    await t.mutation(f.edit, { ...args, id, text: 'Second correction: hold the release' });
    expect((await t.query(f.read, { ...args, id })).entry.sourceBaseVersion).toBeUndefined();
  });
  test('source deletion hides its observations and chapters even before cleanup', async () => {
    const t = harness();
    await enable(t);
    const id = await t.run((ctx) =>
      ctx.db.insert('albatrossIntents', {
        userId,
        rawText: 'Launch',
        source: 'text',
        status: 'captured',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await t.mutation(f.ingest, { ...args, group: 'work' });
    await t.mutation(f.compile, args);
    expect((await t.query(f.search, args)).entries.length).toBeGreaterThan(0);
    await t.run((ctx) => ctx.db.delete(id));
    expect((await t.query(f.search, args)).entries).toEqual([]);
  });
  test('late-arriving evidence is retrieved by observation time, not occurrence time', async () => {
    const t = harness();
    await enable(t);
    const id = await capture(t);
    await t.run((ctx) => ctx.db.patch(id, { occurredAt: 1 }));
    expect((await t.query(f.search, { ...args, changedSince: Date.now() - 1000 })).entries[0]._id).toBe(id);
  });
  test('erase blocks reenabling until its bounded cleanup finishes', async () => {
    const t = harness();
    await enable(t);
    await capture(t);
    await t.mutation(f.erase, args);
    await expect(enable(t)).rejects.toThrow('removal is still finishing');
    await t.mutation((internal as any).narrative.cleanup, { userId, all: true });
    await enable(t);
    expect((await t.query(f.search, args)).enabled).toBe(true);
  });
  test('off by default and forged tenant ids cannot cross the auth boundary', async () => {
    const t = harness();
    expect((await t.query(f.search, args)).enabled).toBe(false);
    expect(await capture(t)).toBeNull();
    await enable(t);
    const id = await capture(t);
    const other = t.withIdentity({ subject: 'other_user' });
    expect((await other.query(f.search, { userId })).entries).toEqual([]);
    expect(await other.query(f.read, { userId, id })).toBeNull();
    await expect(other.mutation(f.edit, { userId, id, text: 'Forged' })).rejects.toThrow('Memory not found');
    await expect(t.query(f.search, { ...args, internalSecret: 'wrong' })).rejects.toThrow();
  });
  test('capture is idempotent and requires source-specific consent', async () => {
    const t = harness();
    await enable(t, ['work']);
    expect(await capture(t)).toBeNull();
    await enable(t, ['chat']);
    const id = await capture(t);
    expect(await capture(t)).toBe(id);
    expect((await t.query(f.search, args)).entries).toHaveLength(1);
  });
  test('compaction builds day/week/month/thread chapters with evidence and trust', async () => {
    const t = harness();
    await enable(t);
    const id = await capture(t);
    await t.mutation(f.compile, args);
    const result = await t.query(f.search, args);
    expect(new Set(result.entries.map((e: any) => e.level))).toEqual(
      new Set(['observation', 'day', 'week', 'month', 'thread']),
    );
    const chapter = result.entries.find((e: any) => e.level === 'week');
    expect(chapter.trust).toBe('inferred');
    expect(chapter.sourceIds).toEqual([id]);
    expect((await t.query(f.read, { ...args, id: chapter._id })).sources[0].trust).toBe('reported');
  });
  test('correction invalidates summaries and stale model publication cannot resurrect them', async () => {
    const t = harness();
    await enable(t);
    const id = await capture(t);
    await t.mutation(f.compile, args);
    const before = await t.query(f.search, args),
      chapter = before.entries.find((e: any) => e.level === 'day');
    await t.mutation(f.edit, { ...args, id, text: 'I postponed the launch' });
    expect((await t.query(f.search, args)).entries).toHaveLength(1);
    expect(
      (
        await t.mutation(f.publish, {
          ...args,
          id: chapter._id,
          revision: before.revision,
          text: 'Ship now',
          model: 'test',
        })
      ).published,
    ).toBe(false);
    await t.mutation(f.compile, args);
    expect((await t.query(f.search, { ...args, level: 'day' })).entries[0].text).toContain('postponed');
  });
  test('forget removes all derived chapters and prevents reingestion', async () => {
    const t = harness();
    await enable(t);
    const id = await capture(t);
    await t.mutation(f.compile, args);
    await t.mutation(f.edit, { ...args, id, forget: true });
    expect((await t.query(f.search, args)).entries).toEqual([]);
    expect(await capture(t)).toBeNull();
  });
  test('source removal immediately revokes reads, before background cleanup', async () => {
    const t = harness();
    await enable(t);
    const id = await capture(t);
    await t.mutation(f.configure, {
      ...args,
      enabled: true,
      sources: ['work'],
      timezone: 'UTC',
      model: 'current',
    });
    expect(await t.query(f.read, { ...args, id })).toBeNull();
    expect((await t.query(f.search, args)).entries).toEqual([]);
    await t.mutation((internal as any).narrative.cleanup, { userId });
    expect(await t.run((ctx) => ctx.db.get(id))).toBeNull();
  });
  test('agent interpretations cannot invent evidence or promote themselves to facts', async () => {
    const t = harness();
    await enable(t);
    const id = await capture(t);
    await t.mutation(f.record, { ...args, text: 'Launch remains open', sourceIds: [id] });
    const result = await t.query(f.search, { ...args, level: 'thread' });
    expect(result.entries[0].trust).toBe('inferred');
    await expect(
      t.mutation(f.record, { ...args, text: 'Confirmed', sourceIds: [result.entries[0]._id] }),
    ).rejects.toThrow('Invalid memory evidence');
  });
  test('run lease prevents concurrent refresh and stale completion cannot release another lease', async () => {
    const t = harness();
    await enable(t);
    expect(await t.mutation(f.claim, { ...args, runId: 'first', kind: 'test' })).not.toBeNull();
    expect(await t.mutation(f.claim, { ...args, runId: 'second', kind: 'test' })).toBeNull();
    await t.mutation(f.finish, { ...args, runId: 'not-owner' });
    expect(await t.mutation(f.claim, { ...args, runId: 'third', kind: 'test' })).toBeNull();
    await t.mutation(f.finish, { ...args, runId: 'first' });
    expect(await t.mutation(f.claim, { ...args, runId: 'second', kind: 'test' })).not.toBeNull();
  });
  test('erase revokes access immediately and cleans stored copies', async () => {
    const t = harness();
    await enable(t);
    await capture(t);
    await t.mutation(f.compile, args);
    await t.mutation(f.erase, args);
    expect((await t.query(f.search, args)).entries).toEqual([]);
    await t.mutation((internal as any).narrative.cleanup, { userId, all: true });
    expect(await t.run((ctx) => ctx.db.query('narrativeEntries').collect())).toEqual([]);
  });
  test('incremental ingestion persists a cursor, deduplicates, and preserves changed source history', async () => {
    const t = harness();
    await enable(t);
    const workId = await t.run((ctx) =>
      ctx.db.insert('albatrossIntents', {
        userId,
        rawText: 'Ship launch',
        title: 'Launch',
        source: 'text',
        status: 'captured',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    expect((await t.mutation(f.ingest, { ...args, group: 'work' })).changed).toBe(1);
    expect((await t.mutation(f.ingest, { ...args, group: 'work' })).changed).toBe(0);
    await t.run((ctx) => ctx.db.patch(workId, { status: 'done', updatedAt: Date.now() }));
    await t.mutation(f.ingest, { ...args, group: 'work' });
    const rows = await t.run((ctx) => ctx.db.query('narrativeEntries').collect());
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.current)).toHaveLength(1);
    expect(rows.find((r) => r.current)?.pinned).toBe(false);
  });
});
