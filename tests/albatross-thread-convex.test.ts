import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import schema from '../convex/schema';

// The Convex side of the Albatross thread (docs/albatross-thread.md):
// personal details rows (server secret only, one step of Undo), steer notes,
// the run history with each run's question, and typed forms on questions.

const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/personalDetails.ts': () => import('../convex/personalDetails'),
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

const SECRET = 'thread-convex-secret';
const userId = 'thread_user';
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

const sealed = (text: string) => `v2.k1.${Buffer.from(text).toString('base64url')}.tag.body`;

async function seedWork(t: Harness) {
  return t.run((ctx) =>
    ctx.db.insert('albatrossIntents', {
      userId,
      rawText: 'Register for the course',
      title: 'Course',
      source: 'text',
      status: 'ready',
      workState: 'active',
      agentState: 'idle',
      createdAt: 1,
      updatedAt: 1,
    } as any),
  );
}

async function openRun(t: Harness, workId: string, token = 'token-1') {
  const { runId } = await t.mutation(api.albatrossStepRuns.enqueue, {
    ...caller,
    workId,
    stepKey: 'step-1',
    stepIdentity: 'step:task:register',
    stepTitle: 'Register for the course',
    trigger: 'user',
  });
  await t.mutation(api.albatrossStepRuns.claim, { ...caller, id: runId as Id<'albatrossStepRuns'>, token });
  return {
    runId: runId as Id<'albatrossStepRuns'>,
    fence: { ...caller, id: runId as Id<'albatrossStepRuns'>, token },
  };
}

describe('personalDetails', () => {
  test('every function needs the server secret', async () => {
    const t = harness();
    await expect(t.query(api.personalDetails.listForUser, { userId })).rejects.toThrow(/internal secret/);
    await expect(
      t.mutation(api.personalDetails.upsert, {
        userId,
        key: 'phone',
        valueEncrypted: sealed('x'),
        source: 'chat',
      }),
    ).rejects.toThrow(/internal secret/);
  });

  test('upsert keeps one row for each key and refuses clear text and unknown keys', async () => {
    const t = harness();
    expect(
      await t.mutation(api.personalDetails.upsert, {
        ...caller,
        key: 'phone',
        valueEncrypted: sealed('a'),
        source: 'settings',
      }),
    ).toEqual({ created: true });
    expect(
      await t.mutation(api.personalDetails.upsert, {
        ...caller,
        key: 'phone',
        valueEncrypted: sealed('b'),
        source: 'settings',
      }),
    ).toEqual({ created: false });
    const rows = await t.query(api.personalDetails.listForUser, caller);
    expect(rows).toHaveLength(1);
    expect(rows[0].valueEncrypted).toBe(sealed('b'));
    await expect(
      t.mutation(api.personalDetails.upsert, {
        ...caller,
        key: 'phone',
        valueEncrypted: '+15555550100',
        source: 'chat',
      }),
    ).rejects.toThrow(/encrypted/);
    await expect(
      t.mutation(api.personalDetails.upsert, {
        ...caller,
        key: 'ssn',
        valueEncrypted: sealed('x'),
        source: 'chat',
      }),
    ).rejects.toThrow(/Unknown/);
  });

  test('rows of one user never show for another', async () => {
    const t = harness();
    await t.mutation(api.personalDetails.upsert, {
      ...caller,
      key: 'email',
      valueEncrypted: sealed('a'),
      source: 'chat',
    });
    expect(
      await t.query(api.personalDetails.listForUser, { internalSecret: SECRET, userId: 'other' }),
    ).toEqual([]);
  });

  test('Undo restores the value before a chat save, or removes a row the save created', async () => {
    const t = harness();
    await t.mutation(api.personalDetails.upsert, {
      ...caller,
      key: 'phone',
      valueEncrypted: sealed('old'),
      source: 'settings',
    });
    await t.mutation(api.personalDetails.upsert, {
      ...caller,
      key: 'phone',
      valueEncrypted: sealed('new'),
      source: 'chat',
    });
    expect(await t.mutation(api.personalDetails.undoSave, { ...caller, key: 'phone' })).toEqual({
      undone: 'restored',
    });
    const [row] = await t.query(api.personalDetails.listForUser, caller);
    expect(row).toMatchObject({ valueEncrypted: sealed('old'), source: 'settings' });
    // A second Undo has nothing left to undo.
    expect(await t.mutation(api.personalDetails.undoSave, { ...caller, key: 'phone' })).toEqual({
      undone: 'none',
    });

    await t.mutation(api.personalDetails.upsert, {
      ...caller,
      key: 'email',
      valueEncrypted: sealed('e'),
      source: 'form',
    });
    expect(await t.mutation(api.personalDetails.undoSave, { ...caller, key: 'email' })).toEqual({
      undone: 'removed',
    });
    expect((await t.query(api.personalDetails.listForUser, caller)).map((entry) => entry.key)).toEqual([
      'phone',
    ]);
  });

  test('a save from Settings has no Undo', async () => {
    const t = harness();
    await t.mutation(api.personalDetails.upsert, {
      ...caller,
      key: 'phone',
      valueEncrypted: sealed('a'),
      source: 'settings',
    });
    expect(await t.mutation(api.personalDetails.undoSave, { ...caller, key: 'phone' })).toEqual({
      undone: 'none',
    });
  });

  test('remove deletes one row', async () => {
    const t = harness();
    await t.mutation(api.personalDetails.upsert, {
      ...caller,
      key: 'phone',
      valueEncrypted: sealed('a'),
      source: 'chat',
    });
    expect(await t.mutation(api.personalDetails.remove, { ...caller, key: 'phone' })).toEqual({
      removed: true,
    });
    expect(await t.mutation(api.personalDetails.remove, { ...caller, key: 'phone' })).toEqual({
      removed: false,
    });
  });
});

describe('steer notes', () => {
  test('a note reaches an open run once, and a closed run refuses notes', async () => {
    const t = harness();
    const workId = String(await seedWork(t));
    const { runId, fence } = await openRun(t, workId);
    expect(
      await t.mutation(api.albatrossStepRuns.steer, {
        ...caller,
        id: runId,
        text: '  Use the Monday class.  ',
      }),
    ).toBe(true);
    expect(await t.mutation(api.albatrossStepRuns.steer, { ...caller, id: runId, text: '   ' })).toBe(false);
    expect(await t.mutation(api.albatrossStepRuns.takeSteerNotes, fence)).toEqual([
      { at: expect.any(Number), text: 'Use the Monday class.' },
    ]);
    expect(await t.mutation(api.albatrossStepRuns.takeSteerNotes, fence)).toEqual([]);
    // A wrong token reads nothing.
    await t.mutation(api.albatrossStepRuns.steer, { ...caller, id: runId, text: 'Second note' });
    expect(await t.mutation(api.albatrossStepRuns.takeSteerNotes, { ...fence, token: 'wrong' })).toEqual([]);

    await t.mutation(api.albatrossStepRuns.cancel, { ...caller, id: runId });
    expect(await t.mutation(api.albatrossStepRuns.steer, { ...caller, id: runId, text: 'Too late' })).toBe(
      false,
    );
  });

  test('a run keeps at most ten notes and another user cannot steer it', async () => {
    const t = harness();
    const workId = String(await seedWork(t));
    const { runId } = await openRun(t, workId);
    for (let index = 0; index < 12; index += 1)
      await t.mutation(api.albatrossStepRuns.steer, { ...caller, id: runId, text: `Note ${index}` });
    const row = await t.run((ctx) => ctx.db.get(runId));
    expect(row?.steer).toHaveLength(10);
    expect(row?.steer?.[0].text).toBe('Note 2');
    await expect(
      t.mutation(api.albatrossStepRuns.steer, {
        internalSecret: SECRET,
        userId: 'other',
        id: runId,
        text: 'x',
      }),
    ).rejects.toThrow(/not found/);
  });
});

describe('run history and forms', () => {
  const form = {
    title: 'Which class?',
    fields: [
      {
        id: 'class',
        label: 'Class',
        kind: 'choice',
        options: [
          { id: 'mon', label: 'Monday, October 19', recommended: 'Matches what you said' },
          { id: 'wed', label: 'Wednesday, October 21' },
        ],
      },
      { id: 'phone', label: 'Phone', kind: 'phone', detailKey: 'phone' },
    ],
  };

  test('a waiting run carries its question with the form, and the answer source shows', async () => {
    const t = harness();
    const workId = await seedWork(t);
    const { runId, fence } = await openRun(t, String(workId));
    const questionId = await t.mutation(api.albatrossWorkV2.upsertQuestion, {
      ...caller,
      workId,
      kind: 'clarification',
      prompt: form.title,
      form,
      dedupeSalt: String(runId),
    });
    await t.mutation(api.albatrossStepRuns.settle, {
      ...fence,
      outcome: 'needs_answer',
      summary: 'Found three classes.',
      next: {
        kind: 'answer',
        label: 'Answer',
        detail: 'Pick a class.',
        target: { kind: 'question', id: String(questionId) },
      },
    });
    let [run] = await t.query(api.albatrossStepRuns.runsForWorkHistory, {
      ...caller,
      workId: String(workId),
    });
    expect(run.question).toMatchObject({ id: String(questionId), status: 'pending', answeredIn: null, form });
    expect(run.parentRunId).toBeNull();
    expect(run.next?.doneLabel).toBeNull();

    await t.mutation(api.albatrossWorkV2.answerQuestion, {
      ...caller,
      questionId: questionId as Id<'albatrossWorkQuestions'>,
      answer: 'Answered in the chat: Monday works.',
    });
    [run] = await t.query(api.albatrossStepRuns.runsForWorkHistory, { ...caller, workId: String(workId) });
    expect(run.question).toMatchObject({ status: 'answered', answeredIn: 'chat' });

    const read = await t.query(api.albatrossWorkV2.questionForAnswer, {
      ...caller,
      questionId: questionId as Id<'albatrossWorkQuestions'>,
    });
    expect(read).toMatchObject({ status: 'answered', form });
    expect(
      await t.query(api.albatrossWorkV2.questionForAnswer, {
        internalSecret: SECRET,
        userId: 'other',
        questionId: questionId as Id<'albatrossWorkQuestions'>,
      }),
    ).toBeNull();
  });

  test('the same title from a new run is a new question, not the old answer', async () => {
    const t = harness();
    const workId = await seedWork(t);
    const first = await t.mutation(api.albatrossWorkV2.upsertQuestion, {
      ...caller,
      workId,
      kind: 'clarification',
      prompt: 'Which class?',
      form,
      dedupeSalt: 'run_a',
    });
    await t.mutation(api.albatrossWorkV2.answerQuestion, {
      ...caller,
      questionId: first as Id<'albatrossWorkQuestions'>,
      answer: 'Class: Monday',
    });
    const second = await t.mutation(api.albatrossWorkV2.upsertQuestion, {
      ...caller,
      workId,
      kind: 'clarification',
      prompt: 'Which class?',
      form,
      dedupeSalt: 'run_b',
    });
    expect(String(second)).not.toBe(String(first));
    const row = await t.run((ctx) => ctx.db.get(second as Id<'albatrossWorkQuestions'>));
    expect(row).toMatchObject({ status: 'pending', form });
  });

  test('history is oldest first, keeps the chain, and is limited', async () => {
    const t = harness();
    const workId = String(await seedWork(t));
    const { runId, fence } = await openRun(t, workId);
    await t.mutation(api.albatrossStepRuns.settle, {
      ...fence,
      outcome: 'your_turn',
      summary: 'Filled the form.',
      next: { kind: 'finish_on_page', label: 'Check and pay', detail: 'Pay the fee.', doneLabel: 'I paid' },
    });
    const child = await t.mutation(api.albatrossStepRuns.enqueue, {
      ...caller,
      workId,
      stepKey: 'step-1',
      stepIdentity: 'step:task:register',
      stepTitle: 'Register for the course',
      trigger: 'resume',
      parentRunId: runId,
    });
    const runs = await t.query(api.albatrossStepRuns.runsForWorkHistory, { ...caller, workId });
    expect(runs.map((run) => run.id)).toEqual([String(runId), String(child.runId)]);
    expect(runs[0].next?.doneLabel).toBe('I paid');
    expect(runs[1].parentRunId).toBe(String(runId));
    expect(
      await t.query(api.albatrossStepRuns.runsForWorkHistory, { ...caller, workId, limit: 1 }),
    ).toHaveLength(1);
  });
});
