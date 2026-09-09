import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api, internal } from '../convex/_generated/api';
import schema from '../convex/schema';

const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/narrative.ts': () => import('../convex/narrative'),
  '../convex/operations.ts': () => import('../convex/operations'),
  '../convex/albatrossIntents.ts': () => import('../convex/albatrossIntents'),
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
  test('shared account consent fits all candidate originals in the read budget and is rechecked next transaction', async () => {
    for (const kind of ['mail', 'calendar', 'mcp']) {
      const t = harness();
      const source = `${kind}:fixture`;
      await enable(t, ['chat', source]);
      const id = await capture(t);
      const seeded = await t.run(async (ctx) => {
        const account =
          kind === 'mcp'
            ? await ctx.db.insert('mcpConnections', {
                userId,
                connectionId: 'fixture',
                server: 'granola',
                serverUrl: 'https://example.test/mcp',
                authKind: 'token',
                status: 'connected',
                scopes: [],
                includeInBrief: true,
                includeInSearch: true,
                createdAt: 1,
                updatedAt: 1,
              })
            : await ctx.db.insert('connectedAccounts', {
                userId,
                accountId: 'fixture',
                email: 'fixture@example.test',
                provider: 'google',
                status: 'connected',
                scopes: [],
                grantId: 'fixture',
                createdAt: 1,
                updatedAt: 1,
              });
        const { _id, _creationTime, ...template } = (await ctx.db.get(id))!;
        const original = await ctx.db.insert('userDocs', {
          userId,
          kind: 'chatSession',
          key: 'fixture',
          doc: {},
          createdAt: 1,
          updatedAt: 1,
        });
        const ids = [];
        for (let i = 0; i < 140; i++)
          ids.push(
            await ctx.db.insert('narrativeEntries', {
              ...template,
              key: `budget:${i}`,
              source,
              sourceTable: 'userDocs',
              sourceId: String(original),
              occurredAt: i + 1,
            }),
          );
        const chapter = await ctx.db.insert('narrativeEntries', {
          ...template,
          key: 'month:fixture',
          level: 'month',
          source: 'derived',
          sourceIds: ids.slice(0, 80),
          occurredAt: 80,
        });
        const prefs = await ctx.db.query('narrativeSettings').first();
        return { account, ids, chapter, revision: prefs!.revision };
      });
      await t.mutation(internal.narrative.compileBucket, {
        userId,
        revision: seeded.revision,
        key: 'month:fixture',
        level: 'month',
        period: 'fixture',
        ids: seeded.ids.slice(80),
        truncated: false,
        compacted: true,
      });
      const chapter = await t.run((ctx) => ctx.db.get(seeded.chapter));
      expect(chapter!.sourceIds).toHaveLength(60);
      expect(chapter!.sourceIds).toContain(seeded.ids[139]);
      expect(chapter!.evidenceTo).toBe(140);
      await t.run((ctx) => ctx.db.patch(seeded.account, { status: 'disconnected' }));
      expect(await t.query(f.read, { ...args, id: seeded.chapter })).toBeNull();
    }
  });

  test('pending prioritizes older threads alongside age-matched calendar chapters', async () => {
    const t = harness();
    await enable(t);
    const id = await capture(t);
    await t.run((ctx) => ctx.db.patch(id, { occurredAt: Date.now() - 86400000 }));
    await t.mutation(f.compile, args);
    const revision = (await t.query(f.read, { ...args, id })).revision;
    await t.mutation(internal.narrative.compileBucket, {
      userId,
      revision,
      key: 'thread:work:launch',
      level: 'thread',
      period: 'work:launch',
      ids: [id],
      truncated: false,
    });
    const entries = (await t.query(f.pending, args)).entries;
    const thread = entries.find((row: any) => row.level === 'thread');
    const day = entries.find((row: any) => row.level === 'day');
    expect(thread).toBeDefined();
    expect(day).toBeDefined();
    await t.run((ctx) => ctx.db.patch(day._id, { occurredAt: Date.now() }));
    expect((await t.query(f.pending, args)).entries[0]._id).toBe(thread._id);
  });

  test('combined timezone and consent changes schedule cleanup once', async () => {
    const t = harness();
    await enable(t, ['chat']);
    const before = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
    await t.mutation(f.configure, {
      ...args,
      enabled: true,
      sources: ['chat', 'work'],
      timezone: 'Asia/Tokyo',
      model: 'current',
    });
    const after = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
    const added = after.filter((row) => !before.some((old) => old._id === row._id));
    expect(added.filter((row) => row.name === 'narrative:cleanup')).toHaveLength(1);
  });

  test('large original records share a byte budget across new and prior compaction evidence', async () => {
    const t = harness();
    await enable(t, ['chat']);
    const id = await capture(t);
    const ids = await t.run(async (ctx) => {
      const { _id, _creationTime, ...template } = (await ctx.db.get(id))!;
      await ctx.db.delete(id);
      const result = [];
      for (let i = 0; i < 10; i++) {
        const original = await ctx.db.insert('userDocs', {
          userId,
          kind: 'chatSession',
          key: `large:${i}`,
          doc: { content: 'x'.repeat(900000) },
          createdAt: 1,
          updatedAt: 1,
        });
        result.push(
          await ctx.db.insert('narrativeEntries', {
            ...template,
            key: `large:${i}`,
            sourceTable: 'userDocs',
            sourceId: String(original),
            topics: [],
          }),
        );
      }
      return result;
    });
    await t.mutation(f.compact, args);
    const chapters = await t.run((ctx) => ctx.db.query('narrativeEntries').collect());
    const chapter = chapters.find((row) => row.level === 'day')!;
    expect(chapter.sourceIds.length).toBeGreaterThan(0);
    expect(chapter.sourceIds.length).toBeLessThanOrEqual(4);
    expect(chapter.coverage).toContain('bounded overview');
    expect(chapters.filter((row) => row.level === 'observation')).toHaveLength(10);
    await t.run((ctx) =>
      ctx.db.patch(chapter._id, {
        sourceIds: ids.map(String),
        model: 'prior-publication',
        text: 'Preserved prior account',
      }),
    );
    await t.mutation(f.compact, args);
    expect((await t.run((ctx) => ctx.db.get(chapter._id)))?.model).toBe('prior-publication');
  });
  test('reordered or duplicate source choices do not reset ingestion and compaction cursors', async () => {
    const t = harness();
    await enable(t, ['chat', 'work']);
    await capture(t);
    await t.mutation(f.compact, args);
    const cursors = await t.run((ctx) => ctx.db.query('narrativeCursors').collect());
    const queued = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
    await t.mutation(f.configure, {
      ...args,
      enabled: true,
      sources: ['work', 'chat', 'chat'],
      timezone: 'America/New_York',
      model: 'current',
    });
    expect(await t.run((ctx) => ctx.db.query('narrativeCursors').collect())).toEqual(cursors);
    expect(await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())).toEqual(queued);
  });
  test('timezone changes revoke old chapters immediately and rebuild without losing observations or new editions', async () => {
    const t = harness();
    await enable(t, ['chat']);
    const id = await capture(t);
    await t.mutation(f.compact, args);
    const old = (await t.query(f.search, { ...args, level: 'day' })).entries[0];
    expect(old).toBeDefined();
    await t.mutation(f.configure, {
      ...args,
      enabled: true,
      sources: ['chat'],
      timezone: 'Asia/Tokyo',
      model: 'current',
    });
    expect(await t.query(f.read, { ...args, id: old._id })).toBeNull();
    expect(await t.query(f.read, { ...args, id })).not.toBeNull();
    expect(await t.run((ctx) => ctx.db.query('narrativeCursors').collect())).toHaveLength(0);
    await t.mutation(f.compact, args);
    await t.mutation(internal.narrative.cleanup, { userId });
    const rebuilt = (await t.query(f.search, { ...args, level: 'day' })).entries;
    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0].derivedEpoch).toBe(1);
    expect(rebuilt[0].sourceIds).toContain(String(id));
  });
  test('pausing retains observations and sweep cursor even if earlier cleanup jobs execute; erase still removes them', async () => {
    const t = harness();
    await enable(t, ['chat']);
    const id = await capture(t);
    await t.mutation(f.compact, args);
    const cursors = await t.run((ctx) => ctx.db.query('narrativeCursors').collect());
    await t.mutation(f.configure, {
      ...args,
      enabled: false,
      sources: ['chat'],
      timezone: 'America/New_York',
      model: 'current',
    });
    await t.mutation(internal.narrative.cleanup, { userId });
    expect(await t.query(f.read, { ...args, id })).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(id))).not.toBeNull();
    expect(await t.run((ctx) => ctx.db.query('narrativeCursors').collect())).toEqual(cursors);
    await t.mutation(f.configure, {
      ...args,
      enabled: true,
      sources: ['chat'],
      timezone: 'America/New_York',
      model: 'current',
    });
    expect((await t.query(f.read, { ...args, id })).entry._id).toBe(id);
    await t.mutation(f.erase, args);
    await t.mutation(internal.narrative.cleanup, { userId, all: true });
    expect(await t.run((ctx) => ctx.db.get(id))).toBeNull();
  });
  test('durable age sweep reaches beyond 800 recent records, retains provenance, and converges', async () => {
    const t = harness();
    await enable(t, ['chat']);
    const id = await capture(t);
    const earliest = Date.UTC(2024, 0, 15, 12);
    await t.run(async (ctx) => {
      const { _id, _creationTime, ...template } = (await ctx.db.get(id))!;
      await ctx.db.patch(id, { occurredAt: earliest, topics: ['repo:older'] });
      for (let i = 1; i <= 900; i++)
        await ctx.db.insert('narrativeEntries', {
          ...template,
          key: `history:${i}`,
          occurredAt: earliest + i * 1000,
          topics: ['repo:older'],
        });
    });
    let pages = 0,
      done = false;
    while (!done && pages++ < 20) {
      done = (await t.mutation(f.compact, args)).done;
      await t.finishAllScheduledFunctions(() => {});
    }
    expect(done).toBe(true);
    expect(pages).toBeGreaterThan(10);
    const entries = await t.run((ctx) => ctx.db.query('narrativeEntries').collect());
    expect(entries.filter((row) => row.level === 'observation')).toHaveLength(901);
    const month = entries.find((row) => row.level === 'month')!;
    expect(month.compactionVersion).toBe(1);
    expect(month.sourceIds).toHaveLength(60);
    expect(month.sourceIds).toContain(id);
    expect(month.evidenceFrom).toBe(earliest);
    expect(month.evidenceTo).toBe(earliest + 900000);
    expect(month.coverage).toContain('representative');
    const detail = await t.query(f.read, { ...args, id: month._id });
    expect(detail.navigation.from).toBe(earliest);
    expect(detail.sources).toHaveLength(60);
    const before = month.sourceIds;
    do {
      done = (await t.mutation(f.compact, args)).done;
      await t.finishAllScheduledFunctions(() => {});
    } while (!done);
    expect((await t.query(f.read, { ...args, id: month._id })).entry.sourceIds).toEqual(before);
    await t.mutation(f.edit, { ...args, id, text: 'Correction: the old release was postponed' });
    expect(await t.query(f.read, { ...args, id: month._id })).toBeNull();
    await t.mutation(f.compact, args);
    expect(
      (await t.query(f.read, { ...args, id: month._id })).sources.find((row: any) => row._id === id)
        .corrected,
    ).toBe(true);
    await t.mutation(f.edit, { ...args, id, forget: true });
    expect(await t.query(f.read, { ...args, id: month._id })).toBeNull();
  });
  test('age policy writes week and month tiers; old exact relationships are indexed outside recent windows', async () => {
    const t = harness();
    await enable(t, ['chat']);
    const old = await capture(t, 'A historical decision', 'old');
    const week = await capture(t, 'A recent-week decision', 'week');
    await t.run(async (ctx) => {
      await ctx.db.patch(old, {
        occurredAt: Date.now() - 180 * 86400000,
        topics: ['repo:needle'],
        topicText: undefined,
      });
      await ctx.db.patch(week, { occurredAt: Date.now() - 30 * 86400000, topics: [] });
      const { _id, _creationTime, ...template } = (await ctx.db.get(week))!;
      for (let i = 0; i < 250; i++)
        await ctx.db.insert('narrativeEntries', {
          ...template,
          key: `noise:${i}`,
          occurredAt: Date.now() - i,
          topics: [],
          topicText: '',
        });
    });
    await t.mutation(f.compact, args);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await t.finishAllScheduledFunctions(() => {});
    const linked = await t.query(f.search, { ...args, topic: 'repo:needle', level: 'observation' });
    expect(linked.entries.map((row: any) => row._id)).toEqual([old]);
    expect((await t.query(f.search, { ...args, level: 'month' })).entries.length).toBeGreaterThan(0);
    expect((await t.query(f.search, { ...args, level: 'week' })).entries.length).toBeGreaterThan(0);
    expect((await t.query(f.search, { ...args, userId: 'other', topic: 'repo:needle' })).entries).toEqual([]);
    await t.mutation(f.configure, {
      ...args,
      enabled: false,
      sources: ['chat'],
      timezone: 'UTC',
      model: 'current',
    });
    expect((await t.mutation(f.compact, args)).scanned).toBe(0);
    expect((await t.query(f.search, { ...args, topic: 'repo:needle' })).entries).toEqual([]);
  });
  test('Work creation, plan generation, and user answers enqueue owned narrative changes with no completion inflation', async () => {
    const t = harness();
    await enable(t, ['work']);
    const id = await t.mutation(api.albatrossIntents.createIntent, {
      ...args,
      rawText: 'Prepare Atlas launch',
      source: 'text',
    });
    const queued = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
    expect(
      queued.some((job) => job.name === 'narrative:captureSource' && job.args[0].id === String(id)),
    ).toBe(true);
    await t.mutation(internal.narrative.captureSource, { userId, table: 'albatrossIntents', id: String(id) });
    expect((await t.query(f.search, { ...args, topic: `work:${id}` })).entries).toHaveLength(1);
    await t.mutation(api.albatrossIntents.savePlan, {
      ...args,
      intentId: id as any,
      questions: [{ id: 'day', prompt: 'Which day?' }],
      digitalActions: [],
      physicalActions: [],
      assumptions: [],
      sourceRefs: [],
    });
    await t.mutation(api.albatrossIntents.answerQuestions, {
      ...args,
      intentId: id as any,
      answers: [{ id: 'day', answer: 'Friday' }],
    });
    await t.mutation(internal.narrative.captureSource, { userId, table: 'albatrossIntents', id: String(id) });
    const found = (await t.query(f.search, { ...args, topic: `work:${id}` })).entries;
    expect(found.some((entry: any) => entry.text.includes('Your answer: Friday'))).toBe(true);
    expect(found.some((entry: any) => entry.text.includes('Generated steps are proposals'))).toBe(true);
    const decision = found.find((entry: any) => entry.key.endsWith(':answer:day'));
    const beforeJobs = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
    await t.mutation(api.albatrossIntents.answerQuestions, {
      ...args,
      intentId: id as any,
      answers: [{ id: 'day', answer: '' }],
    });
    const afterJobs = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
    expect(
      afterJobs.some(
        (job) =>
          !beforeJobs.some((previous) => previous._id === job._id) &&
          job.name === 'narrative:captureSource' &&
          job.args[0].id === String(id),
      ),
    ).toBe(true);
    expect(await t.query(f.read, { ...args, id: decision._id })).toBeNull();
    const prefs = await t.run(async (ctx) => (await ctx.db.query('narrativeSettings').collect())[0]);
    expect(prefs.refreshToken).toBeTruthy();
  });
  test('scheduled refresh batches rotate fairly through more than 100 users', async () => {
    const t = harness();
    await t.run(async (ctx) => {
      for (let index = 0; index < 205; index++)
        await ctx.db.insert('narrativeSettings', {
          userId: `rotation-${index}`,
          enabled: index < 204,
          sources: ['chat'],
          timezone: 'UTC',
          model: 'current',
          revision: 1,
          createdAt: 1,
          updatedAt: 1,
        });
    });
    const selected = new Set<string>();
    for (let pass = 0; pass < 3; pass++) {
      const batch = await t.mutation(internal.narrative.targets, {});
      expect(batch).toHaveLength(100);
      batch.forEach((id: string) => {
        selected.add(id);
      });
    }
    expect(selected.size).toBe(204);
    expect(selected.has('rotation-204')).toBe(false);
  });
  test('individual source opt-outs survive erase, cleanup, and re-enabling', async () => {
    const t = harness();
    await enable(t);
    const id = await capture(t);
    await t.mutation(f.edit, { ...args, id, forget: true });
    await t.mutation(f.erase, args);
    await t.mutation(internal.narrative.cleanup, { userId, all: true });
    expect(await t.run((ctx) => ctx.db.query('narrativeEntries').collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query('narrativeExclusions').collect())).toHaveLength(1);
    await enable(t);
    expect(await capture(t)).toBeNull();
    expect((await t.query(f.search, args)).entries).toEqual([]);
  });
  test('a stale failed refresh token cannot suppress future captures', async () => {
    const t = harness();
    await enable(t);
    await t.run(async (ctx) => {
      const prefs = (await ctx.db.query('narrativeSettings').collect())[0];
      await ctx.db.patch(prefs._id, { refreshToken: 'stuck-token', refreshScheduledAt: Date.now() - 600000 });
    });
    await capture(t);
    const prefs = await t.run(async (ctx) => (await ctx.db.query('narrativeSettings').collect())[0]);
    expect(prefs.refreshToken).not.toBe('stuck-token');
    expect(prefs.refreshScheduledAt).toBeGreaterThan(Date.now());
  });
  test('malformed narrative IDs are recoverable reads, not internal validation failures', async () => {
    const t = harness();
    await enable(t);
    expect(await t.query(f.read, { ...args, id: 'not-a-convex-id' })).toBeNull();
    expect(await t.query(f.read, { ...args, id: '', sources: true })).toBeNull();
  });
  test('large compactions schedule bounded continuations and reject obsolete revisions', async () => {
    const t = harness();
    await enable(t);
    const observation = await capture(t);
    await t.run(async (ctx) => {
      const template = (await ctx.db.get(observation))!;
      const { _id, _creationTime, ...data } = template;
      for (let day = 0; day < 80; day++)
        await ctx.db.insert('narrativeEntries', {
          ...data,
          key: `stress:${day}`,
          occurredAt: Date.now() - day * 86400000,
          topics: [`work:project-${day}`],
        });
    });
    const result = await t.mutation(f.compile, args);
    expect(result.count).toBeGreaterThan(80);
    const initial = await t.run((ctx) => ctx.db.query('narrativeEntries').collect());
    expect(initial.filter((row) => row.level !== 'observation')).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await t.finishAllScheduledFunctions(() => {});
    const finished = await t.run((ctx) => ctx.db.query('narrativeEntries').collect());
    expect(finished.filter((row) => row.level !== 'observation').length).toBeGreaterThan(80);
    const revision = (await t.query(f.status, args)).settings.revision;
    await t.mutation(f.edit, { ...args, id: observation, text: 'Changed after scheduling' });
    await t.mutation((internal as any).narrative.compileBucket, {
      userId,
      revision,
      key: 'thread:obsolete',
      level: 'thread',
      period: 'obsolete',
      ids: [observation],
      truncated: false,
    });
    expect((await t.query(f.search, { ...args, query: 'obsolete' })).entries).toEqual([]);
  });
  test('legacy operation receipts have a bounded, owned, consent-checked history cursor', async () => {
    const t = harness();
    await enable(t, ['work']);
    const now = Date.now();
    await t.run(async (ctx) => {
      for (let index = 0; index < 42; index++) {
        await ctx.db.insert('aiOperations', {
          userId,
          agent: 'ai',
          tool: 'tasks_create_card',
          surface: 'tasks',
          summary: `Legacy action ${index}`,
          target: { kind: 'card', id: `card-${index}` },
          status: index === 0 ? 'undone' : 'applied',
          createdAt: now - 1000,
          ...(index === 0 ? { undoneAt: now - 500 } : {}),
        });
      }
      const operation = {
        userId,
        agent: 'ai' as const,
        tool: 'tasks_create_card',
        surface: 'tasks' as const,
        summary: 'Not in scope',
        target: { kind: 'card', id: 'hidden' },
        status: 'applied' as const,
        createdAt: now - 1000,
      };
      await ctx.db.insert('aiOperations', { ...operation, userId: 'another-user' });
      await ctx.db.insert('aiOperations', { ...operation, createdAt: now - 31 * 86400000 });
      await ctx.db.insert('aiOperations', {
        ...operation,
        surface: 'mail',
        target: { kind: 'mail', accountId: 'unselected' },
      });
    });
    const first = await t.mutation(f.ingest, { ...args, group: 'operationHistory' });
    expect(first).toEqual({ done: false, changed: 40 });
    expect(await t.mutation(f.ingest, { ...args, group: 'operationHistory' })).toEqual({
      done: true,
      changed: 2,
    });
    expect((await t.mutation(f.ingest, { ...args, group: 'operationHistory' })).changed).toBe(0);
    const rows = await t.run((ctx) => ctx.db.query('narrativeEntries').collect());
    expect(rows).toHaveLength(42);
    expect(rows.every((row) => row.userId === userId && row.source === 'work')).toBe(true);
    expect(rows.some((row) => row.text.includes('was undone'))).toBe(true);
    // Importing narrative history never rewrites the original action log.
    expect(
      (await t.run((ctx) => ctx.db.query('aiOperations').collect())).every(
        (row) => row.updatedAt === undefined,
      ),
    ).toBe(true);
  });
  test('applied operations are captured from owned receipts and undo invalidates the old current fact', async () => {
    const t = harness();
    await enable(t, ['work']);
    const id = await t.mutation(api.operations.record, {
      ...args,
      agent: 'ai',
      tool: 'tasks_create_card',
      surface: 'tasks',
      summary: 'Added Atlas QA',
      target: { kind: 'card', id: 'card', workId: 'atlas' },
      inverse: { kind: 'tasks.delete_card', payload: { cardId: 'card' } },
    });
    // Exercise the durable worker directly as well as its scheduled retry.
    await t.mutation((internal as any).narrative.captureSource, {
      userId,
      table: 'aiOperations',
      id: String(id),
    });
    await t.finishAllScheduledFunctions(() => {});
    const old = (await t.query(f.search, { ...args, level: 'observation' })).entries[0];
    expect(old.sourceTable).toBe('aiOperations');
    expect(old.trust).toBe('observed');
    expect(old.topics).toContain('work:atlas');
    expect(old.text).toContain('not completing it');
    expect(
      (
        await t.mutation((internal as any).narrative.captureSource, {
          userId,
          table: 'aiOperations',
          id: String(id),
        })
      ).changed,
    ).toBe(0);
    await t.mutation(f.edit, {
      ...args,
      id: old._id,
      text: 'User correction: the card only covers keyboard QA, not the full review.',
    });
    expect((await t.query(f.read, { ...args, id: old._id })).entry.text).toContain('User correction');
    const caller = { ...args, operationId: id, claimToken: 'claim' };
    await t.mutation(api.operations.claimUndo, { ...caller, leaseMs: 1000 });
    expect(await t.query(f.read, { ...args, id: old._id })).toBeNull();
    await t.mutation(api.operations.completeUndo, caller);
    await t.mutation((internal as any).narrative.captureSource, {
      userId,
      table: 'aiOperations',
      id: String(id),
    });
    const current = (await t.query(f.search, { ...args, level: 'observation' })).entries.find(
      (entry: any) => entry.current,
    );
    expect(current.text).toContain('was undone');
    expect((await t.query(f.read, { ...args, id: old._id })).entry.current).toBe(false);
    // Removing the original receipt also revokes derived access.
    await t.run((ctx) => ctx.db.delete(id));
    expect(await t.query(f.read, { ...args, id: current._id })).toBeNull();
  });
  test('capture rejects cross-user source ids and respects explicit source consent', async () => {
    const t = harness();
    await enable(t, ['chat']);
    const id = await t.run((ctx) =>
      ctx.db.insert('albatrossIntents', {
        userId,
        rawText: 'Atlas',
        source: 'text',
        status: 'captured',
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    const capture = (who: string, sourceId = String(id)) =>
      t.mutation((internal as any).narrative.captureSource, {
        userId: who,
        table: 'albatrossIntents',
        id: sourceId,
      });
    expect((await capture(userId)).changed).toBe(0);
    expect((await capture('someone-else')).changed).toBe(0);
    await enable(t, ['work']);
    expect((await capture(userId, 'invalid')).changed).toBe(0);
    expect((await capture(userId)).changed).toBe(1);
    await t.run((ctx) => ctx.db.patch(id, { userId: 'someone-else' }));
    expect((await capture(userId)).changed).toBe(0);
  });
  test('bursts coalesce into a durable refresh, wait for active runs, and cannot survive disable', async () => {
    const t = harness();
    await enable(t);
    await capture(t, 'First plan', 'first');
    const prefs = () => t.run((ctx) => ctx.db.query('narrativeSettings').first());
    const queued = await prefs();
    expect(queued?.refreshToken).toBeDefined();
    expect(queued?.refreshScheduledAt).toBeGreaterThan(Date.now());
    await capture(t, 'Another plan', 'second');
    expect((await prefs())?.refreshToken).toBe(queued?.refreshToken);
    await t.mutation(f.claim, { ...args, runId: 'active', kind: 'test' });
    await t.mutation((internal as any).narrative.flushRefresh, { userId, token: queued!.refreshToken });
    expect((await prefs())?.refreshScheduledAt).toBeGreaterThan((await prefs())!.leaseUntil!);
    await t.mutation(f.configure, {
      ...args,
      enabled: false,
      sources: [],
      timezone: 'UTC',
      model: 'current',
    });
    expect((await prefs())?.refreshToken).toBeUndefined();
    await t.mutation((internal as any).narrative.flushRefresh, { userId, token: queued!.refreshToken });
    expect(await t.query((internal as any).narrative.refreshTarget, { userId })).toBe(false);
    await t.action((internal as any).narrative.refreshUser, { userId });
  });
  test.each([
    false,
    true,
  ])('corrections block replay without freezing future changes (missing baseline: %s)', async (missingBaseline) => {
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
    if (missingBaseline) await t.run((ctx) => ctx.db.patch(old._id, { sourceBaseVersion: undefined }));
    await t.run(async (ctx) => {
      const cursors = await ctx.db.query('narrativeCursors').collect();
      for (const cursor of cursors) await ctx.db.delete(cursor._id);
    });
    await t.mutation(f.ingest, { ...args, group: 'work' });
    expect((await t.query(f.search, { ...args, level: 'observation' })).entries[0].text).toBe(
      'Wait for QA before shipping',
    );
    expect((await t.query(f.read, { ...args, id: old._id })).entry.sourceBaseVersion).toBe(old.sourceVersion);
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
  test('recent history builds detailed day and active thread chapters with evidence and trust', async () => {
    const t = harness();
    await enable(t);
    const id = await capture(t);
    await t.mutation(f.compile, args);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await t.finishAllScheduledFunctions(() => {});
    const result = await t.query(f.search, args);
    expect(new Set(result.entries.map((e: any) => e.level))).toEqual(
      new Set(['observation', 'day', 'thread']),
    );
    const chapter = result.entries.find((e: any) => e.level === 'day');
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
  test('forget revokes a long version history immediately and deletes it in bounded jobs', async () => {
    const t = harness();
    await enable(t);
    const id = await capture(t);
    const other = await capture(t, 'An unrelated source stays available', 'other');
    const latest = await t.run(async (ctx) => {
      const row = (await ctx.db.get(id))!;
      const { _id, _creationTime, ...version } = row;
      await ctx.db.patch(id, { current: false });
      let result = id;
      for (let index = 0; index < 240; index++)
        result = await ctx.db.insert('narrativeEntries', {
          ...version,
          current: index === 239,
          sourceVersion: `version:${index}`,
        });
      return result;
    });
    await t.mutation(f.record, { ...args, text: 'A linked interpretation', sourceIds: [latest] });
    const thread = (await t.query(f.search, { ...args, level: 'thread' })).entries[0];
    await t.mutation(f.edit, { ...args, id: latest, forget: true });
    const remaining = await t.run((ctx) =>
      ctx.db
        .query('narrativeEntries')
        .withIndex('by_user_key', (q) => q.eq('userId', userId).eq('key', 'turn:m1'))
        .collect(),
    );
    expect(remaining).toHaveLength(221);
    expect(await t.query(f.read, { ...args, id: latest })).toBeNull();
    expect(await t.query(f.read, { ...args, id: thread._id })).toBeNull();
    expect(await capture(t)).toBeNull();
    const queued = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
    expect(queued.some((job) => job.name === 'narrative:cleanupForgotten')).toBe(true);
    // Run the durable continuation directly: real timer scheduling is not
    // advanced by this harness's no-op finishAllScheduledFunctions callback.
    for (let page = 0; page < 12; page++)
      await t.mutation(internal.narrative.cleanupForgotten, { userId, key: 'turn:m1' });
    await t.mutation(internal.narrative.cleanup, { userId });
    expect(await t.run((ctx) => ctx.db.get(latest))).toBeNull();
    expect(await t.query(f.read, { ...args, id: other })).not.toBeNull();
    expect(await t.run((ctx) => ctx.db.query('narrativeEntries').collect())).toHaveLength(1);
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
