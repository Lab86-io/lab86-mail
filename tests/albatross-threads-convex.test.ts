import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import { USER_OPEN_MAX, USER_RUNNING_MAX } from '../convex/albatrossStepRuns';
import schema from '../convex/schema';

// The Convex side of many threads at once (docs/albatross-threads.md): up to
// ten runs work, more wait as "Starts soon", notes carry to the next run, a
// stopped run tells its runner at the next step, and the small thread rows.

const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/albatrossThreads.ts': () => import('../convex/albatrossThreads'),
  '../convex/albatrossStepRuns.ts': () => import('../convex/albatrossStepRuns'),
  '../convex/albatrossBrowserSessions.ts': () => import('../convex/albatrossBrowserSessions'),
  '../convex/albatrossWorkV2.ts': () => import('../convex/albatrossWorkV2'),
  '../convex/albatrossIntents.ts': () => import('../convex/albatrossIntents'),
  '../convex/albatrossWork.ts': () => import('../convex/albatrossWork'),
  '../convex/albatrossNotifications.ts': () => import('../convex/albatrossNotifications'),
  '../convex/boards.ts': () => import('../convex/boards'),
  '../convex/mobile.ts': () => import('../convex/mobile'),
  '../convex/albatross.ts': () => import('../convex/albatross'),
};

const SECRET = 'threads-convex-secret';
const userId = 'threads_user';
const caller = { internalSecret: SECRET, userId };
let previousSecret: string | undefined;

beforeAll(() => {
  previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
});

const harness = () => convexTest(schema, modules);
type Harness = ReturnType<typeof harness>;

async function seedWork(t: Harness, title = 'Renew the car registration') {
  return String(
    await t.run((ctx) =>
      ctx.db.insert('albatrossIntents', {
        userId,
        rawText: title,
        title,
        source: 'text',
        status: 'ready',
        workState: 'active',
        agentState: 'idle',
        createdAt: 1,
        updatedAt: 1,
      } as any),
    ),
  );
}

async function enqueue(t: Harness, workId: string, extra: Record<string, unknown> = {}) {
  return t.mutation(api.albatrossStepRuns.enqueue, {
    ...caller,
    workId,
    stepKey: 'step-1',
    stepIdentity: `step:${workId}`,
    stepTitle: 'Renew online',
    trigger: 'user',
    ...extra,
  } as any);
}

async function claim(t: Harness, runId: string, token = `tk-${runId}`) {
  return t.mutation(api.albatrossStepRuns.claim, { ...caller, id: runId as Id<'albatrossStepRuns'>, token });
}

describe('the run queue', () => {
  test('ten runs work at once; the eleventh waits, then starts when one ends', async () => {
    const t = harness();
    const runIds: string[] = [];
    for (let index = 0; index <= USER_RUNNING_MAX; index += 1) {
      const workId = await seedWork(t, `Work ${index}`);
      const queued = await enqueue(t, workId);
      expect(queued).toMatchObject({ created: true });
      runIds.push(String(queued.runId));
    }
    for (const runId of runIds.slice(0, USER_RUNNING_MAX)) expect(await claim(t, runId)).not.toBeNull();
    // The eleventh waits: no claim, a later retry time, still queued.
    expect(await claim(t, runIds[USER_RUNNING_MAX])).toBeNull();
    const waiting = await t.run((ctx) => ctx.db.get(runIds[USER_RUNNING_MAX] as Id<'albatrossStepRuns'>));
    expect(waiting?.state).toBe('queued');
    expect(waiting!.availableAt).toBeGreaterThan(Date.now());
    // A run ends: the waiting run is due at once.
    await t.mutation(api.albatrossStepRuns.settle, {
      ...caller,
      id: runIds[0] as Id<'albatrossStepRuns'>,
      token: `tk-${runIds[0]}`,
      outcome: 'done',
      summary: 'Done.',
    });
    const due = await t.run((ctx) => ctx.db.get(runIds[USER_RUNNING_MAX] as Id<'albatrossStepRuns'>));
    expect(due!.availableAt).toBeLessThanOrEqual(Date.now());
    expect(await claim(t, runIds[USER_RUNNING_MAX])).not.toBeNull();
  });

  test('a cancel also frees a slot; the open guard refuses only past its cap', async () => {
    const t = harness();
    expect(USER_OPEN_MAX).toBeGreaterThan(USER_RUNNING_MAX);
    const first = await enqueue(t, await seedWork(t));
    await claim(t, String(first.runId));
    expect(
      await t.mutation(api.albatrossStepRuns.cancel, {
        ...caller,
        id: first.runId as Id<'albatrossStepRuns'>,
      }),
    ).toMatchObject({
      cancelled: true,
    });
    await t.run(async (ctx) => {
      for (let index = 0; index < USER_OPEN_MAX; index += 1)
        await ctx.db.insert('albatrossStepRuns', {
          userId,
          workId: `fill-${index}`,
          stepKey: 's',
          stepIdentity: 's',
          stepTitle: 's',
          trigger: 'user',
          state: 'queued',
          active: true,
          availableAt: Date.now() + 60_000,
          attempts: 0,
          log: [],
          artifacts: [],
          createdAt: 1,
          updatedAt: 1,
        } as any);
    });
    expect(await enqueue(t, await seedWork(t, 'One more'))).toMatchObject({ created: false, reason: 'busy' });
  });
});

describe('steering', () => {
  test('a note keeps its id, a retry does not add it twice, and the view shows it', async () => {
    const t = harness();
    const { runId } = await enqueue(t, await seedWork(t));
    const id = runId as Id<'albatrossStepRuns'>;
    expect(
      await t.mutation(api.albatrossStepRuns.steer, {
        ...caller,
        id,
        text: 'Use the Monday class',
        noteId: 'm1',
      }),
    ).toBe(true);
    expect(
      await t.mutation(api.albatrossStepRuns.steer, {
        ...caller,
        id,
        text: 'Use the Monday class',
        noteId: 'm1',
      }),
    ).toBe(true);
    const view = await t.query(api.albatrossStepRuns.get, { ...caller, id });
    expect(view?.notes).toEqual([
      { id: 'm1', at: expect.any(Number), text: 'Use the Monday class', readAt: null },
    ]);
  });

  test('a stopped run tells its runner at the next step; unread notes carry to the next run', async () => {
    const t = harness();
    const workId = await seedWork(t);
    const { runId } = await enqueue(t, workId);
    const id = runId as Id<'albatrossStepRuns'>;
    await claim(t, String(runId), 'tk');
    await t.mutation(api.albatrossStepRuns.steer, { ...caller, id, text: 'First note', noteId: 'n1' });
    const fence = { ...caller, id, token: 'tk' };
    expect(await t.mutation(api.albatrossStepRuns.takeSteerNotes, fence)).toEqual([
      { at: expect.any(Number), text: 'First note' },
    ]);
    await t.mutation(api.albatrossStepRuns.steer, { ...caller, id, text: 'Second note', noteId: 'n2' });
    await t.mutation(api.albatrossStepRuns.cancel, { ...caller, id });
    expect(await t.mutation(api.albatrossStepRuns.takeSteerNotes, fence)).toBeNull();
    const next = await enqueue(t, workId, { trigger: 'resume', parentRunId: id, resumeNote: 'Go back' });
    const view = await t.query(api.albatrossStepRuns.get, {
      ...caller,
      id: next.runId as Id<'albatrossStepRuns'>,
    });
    expect(view?.notes.map((note) => [note.id, note.text, note.readAt])).toEqual([
      ['n2', 'Second note', null],
    ]);
  });
});

describe('albatrossThreads', () => {
  test('activity: the open run wins, then the newest finished run; thread rows by Work', async () => {
    const t = harness();
    const workA = await seedWork(t, 'A');
    const workB = await seedWork(t, 'B');
    const old = await enqueue(t, workA);
    await claim(t, String(old.runId), 'tk-old');
    await t.mutation(api.albatrossStepRuns.settle, {
      ...caller,
      id: old.runId as Id<'albatrossStepRuns'>,
      token: 'tk-old',
      outcome: 'ready_for_you',
      summary: 'I saved a draft.',
      next: { kind: 'review_draft', label: 'Read and send', detail: 'Read the draft.' },
    });
    const live = await enqueue(t, workA);
    await t.mutation(api.albatrossThreads.replyStarted, { ...caller, workId: workB, turn: 't1' });
    const activity = await t.query(api.albatrossThreads.activity, caller);
    expect(activity.runs[workA]).toMatchObject({ runId: String(live.runId), state: 'queued' });
    expect(activity.threads[workB]).toMatchObject({ answering: true, replyWaits: false });
    expect(activity.now).toBeNumber();
  });

  test('a reply ends; only the reply that started last clears "answering"', async () => {
    const t = harness();
    const workId = await seedWork(t);
    await t.mutation(api.albatrossThreads.replyStarted, { ...caller, workId, turn: 'old' });
    await t.mutation(api.albatrossThreads.replyStarted, { ...caller, workId, turn: 'new' });
    await t.mutation(api.albatrossThreads.replyEnded, { ...caller, workId, turn: 'old', waits: false });
    expect((await t.query(api.albatrossThreads.activity, caller)).threads[workId].answering).toBe(true);
    await t.mutation(api.albatrossThreads.replyEnded, {
      ...caller,
      workId,
      turn: 'new',
      waits: true,
      preview: 'Which class date?',
    });
    expect((await t.query(api.albatrossThreads.activity, caller)).threads[workId]).toMatchObject({
      answering: false,
      replyWaits: true,
      replyPreview: 'Which class date?',
      replyAt: expect.any(Number),
    });
  });

  test('seen: only the owner, only a real Work; server-only reply marks', async () => {
    const t = harness();
    const workId = await seedWork(t);
    expect((await t.mutation(api.albatrossThreads.markSeen, { ...caller, workId })).seenAt).toBeNumber();
    expect((await t.query(api.albatrossThreads.activity, caller)).threads[workId].seenAt).toBeNumber();
    await expect(
      t.mutation(api.albatrossThreads.markSeen, { ...caller, userId: 'other', workId }),
    ).rejects.toThrow(/not found/);
    await expect(t.mutation(api.albatrossThreads.markSeen, { ...caller, workId: 'bad id!' })).rejects.toThrow(
      /Invalid/,
    );
    await expect(
      t.mutation(api.albatrossThreads.replyStarted, { internalSecret: 'wrong', userId, workId, turn: 'x' }),
    ).rejects.toThrow(/internal secret/);
    await expect(t.query(api.albatrossThreads.activity, {})).rejects.toThrow(/Not authenticated/);
  });
});
