import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api } from '../convex/_generated/api';
import schema from '../convex/schema';
import {
  checkpointOutput,
  executeCheckpointedTool,
  readRecoveryContext,
  toolExecutionKey,
} from '../lib/ai/execution';
import { buildAlbatrossDailyReportContextFromLive } from '../lib/albatross/daily-report';
import { progressEvidenceSchema } from '../lib/albatross/progress-evidence';
import { prepareDocumentEdits } from '../lib/documents/edits';
import { createDefaultDocumentModel } from '../lib/documents/model';

const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/albatrossWorkV2.ts': () => import('../convex/albatrossWorkV2'),
  '../convex/albatrossIntents.ts': () => import('../convex/albatrossIntents'),
  '../convex/albatrossWork.ts': () => import('../convex/albatrossWork'),
  '../convex/boards.ts': () => import('../convex/boards'),
  '../convex/documents.ts': () => import('../convex/documents'),
  '../convex/agentExecution.ts': () => import('../convex/agentExecution'),
};
const caller = { internalSecret: 'dogfood-regression-secret', userId: 'dogfood-user' };
let previous: string | undefined;
beforeAll(() => {
  previous = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = caller.internalSecret;
});
afterAll(() => {
  if (previous === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previous;
});
const harness = () => convexTest(schema, modules);
async function seedWork(t: ReturnType<typeof harness>) {
  return t.run((ctx) =>
    ctx.db.insert('albatrossIntents', {
      userId: caller.userId,
      rawText: 'Repair the tire',
      title: 'Monro',
      source: 'chat',
      status: 'planning',
      workState: 'active',
      agentState: 'researching',
      planError: 'Old timeout',
      createdAt: 1,
      updatedAt: 1,
    }),
  );
}

describe('Monro completion', () => {
  test('supersedes pending questions and rejects approvals created after completion', async () => {
    const t = harness();
    const workId = await seedWork(t);
    const question = { ...caller, workId, kind: 'completion' as const, prompt: 'Is it repaired?' };
    await t.mutation(api.albatrossWorkV2.upsertQuestion, question);
    const approval = {
      ...caller,
      intentId: workId,
      kind: 'calendar_invite' as const,
      title: 'Visit the shop',
      toolName: 'calendar_create_event',
      toolArgs: {},
    };
    const approvalId = await t.mutation(api.albatrossWork.enqueueApproval, approval);
    await t.mutation(api.albatrossWorkV2.completeWork, { ...caller, workId, claim: 'Done' });
    await t.mutation(api.albatrossWorkV2.upsertQuestion, { ...question, prompt: 'Late question' });
    expect(await t.run((ctx) => ctx.db.query('albatrossWorkQuestions').collect())).toMatchObject([
      { status: 'superseded' },
    ]);
    expect((await t.run((ctx) => ctx.db.get(approvalId)))?.status).toBe('rejected');
    await expect(t.mutation(api.albatrossWork.enqueueApproval, approval)).rejects.toThrow('Reopen');
    await expect(t.mutation(api.albatrossWork.claimApproval, { ...caller, approvalId })).rejects.toThrow();
    await expect(
      t.mutation(api.albatrossWork.createProject, {
        ...caller,
        title: 'Late project',
        sourceIntentId: workId,
      }),
    ).rejects.toThrow('Reopen');
  });

  test('a shared project stays active when one of its outcomes finishes', async () => {
    const t = harness();
    const workId = await seedWork(t);
    const otherWork = await seedWork(t);
    const projectId = await t.mutation(api.albatrossWork.createProject, {
      ...caller,
      title: 'Vehicle work',
      sourceIntentId: workId,
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(workId, { primaryProjectId: projectId });
      await ctx.db.insert('albatrossProjectLinks', {
        userId: caller.userId,
        projectId,
        artifactKind: 'intent',
        artifactId: otherWork,
        role: 'primary',
        createdAt: 1,
        updatedAt: 1,
      });
    });
    await t.mutation(api.albatrossWorkV2.completeWork, { ...caller, workId, claim: 'Done' });
    const project = await t.run((ctx) => ctx.db.get(projectId));
    expect(project?.status).toBe('active');
    expect(
      buildAlbatrossDailyReportContextFromLive({
        projects: [project],
        workStates: [{ id: workId, workState: 'done' }],
      }).activeProjects,
    ).toHaveLength(1);
  });

  test('completion is atomic, idempotent and rejects late planning writes', async () => {
    const t = harness();
    const workId = await seedWork(t);
    await t.mutation(api.albatrossWorkV2.completeWork, { ...caller, workId, claim: 'The repair is done.' });
    await t.mutation(api.albatrossWorkV2.completeWork, { ...caller, workId, claim: 'The repair is done.' });
    await t.mutation(api.albatrossWorkV2.setAgentState, {
      ...caller,
      workId,
      agentState: 'error',
      error: 'Late timeout',
    });
    await t.mutation(api.albatrossIntents.updateIntent, {
      ...caller,
      intentId: workId,
      status: 'planning',
      planError: 'Late error',
    });
    await expect(
      t.mutation(api.albatrossIntents.savePlan, {
        ...caller,
        intentId: workId,
        digitalActions: [],
        physicalActions: [],
        assumptions: [],
        sourceRefs: [],
      }),
    ).rejects.toThrow('Reopen');
    const work = await t.run((ctx) => ctx.db.get(workId));
    expect(work).toMatchObject({ workState: 'done', status: 'done', agentState: 'idle' });
    expect(work?.planError).toBeUndefined();
    expect(await t.run((ctx) => ctx.db.query('completionEvents').collect())).toHaveLength(1);
    expect(await t.run((ctx) => ctx.db.query('albatrossEvidence').collect())).toHaveLength(1);
    expect(
      await t.query(api.albatrossWorkV2.inactiveBriefRefs, {
        ...caller,
        refs: [{ kind: 'work', id: workId }],
      }),
    ).toEqual([workId]);
    expect(
      await t.query(api.albatrossWorkV2.inactiveBriefRefs, {
        ...caller,
        userId: 'another-user',
        refs: [{ kind: 'work', id: workId }],
      }),
    ).toEqual([]);
  });

  test('retires only owned unfinished tasks, closes its project, and restores on reopen', async () => {
    const t = harness();
    const workId = await seedWork(t);
    const ids = await t.run(async (ctx) => {
      const boardId = await ctx.db.insert('boards', {
        ownerUserId: caller.userId,
        title: 'Tasks',
        createdAt: 1,
        updatedAt: 1,
      });
      const columnId = await ctx.db.insert('boardColumns', {
        boardId,
        name: 'Today',
        order: 0,
        createdAt: 1,
        updatedAt: 1,
      });
      const projectId = await ctx.db.insert('albatrossProjects', {
        userId: caller.userId,
        title: 'Repair',
        status: 'active',
        sourceIntentId: workId,
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.patch(workId, { primaryProjectId: projectId });
      const base = { boardId, columnId, userId: caller.userId, order: 0, createdAt: 1, updatedAt: 1 };
      const owned = await ctx.db.insert('cards', { ...base, title: 'Inflate', source: { intentId: workId } });
      const done = await ctx.db.insert('cards', {
        ...base,
        title: 'Booked',
        source: { intentId: workId },
        completedAt: 2,
      });
      const independent = await ctx.db.insert('cards', { ...base, title: 'Other repair' });
      return { owned, done, independent, projectId };
    });
    await t.mutation(api.albatrossWorkV2.completeWork, { ...caller, workId, claim: 'Done' });
    expect(await t.run((ctx) => ctx.db.get(ids.owned))).toMatchObject({ retiredByWorkId: workId });
    expect((await t.run((ctx) => ctx.db.get(ids.owned)))?.completedAt).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(ids.done)))?.retiredAt).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(ids.independent)))?.retiredAt).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(ids.projectId)))?.status).toBe('done');
    expect(
      await t.query(api.albatrossWorkV2.inactiveBriefRefs, {
        ...caller,
        refs: [
          { kind: 'task', id: ids.owned },
          { kind: 'task', id: ids.independent },
        ],
      }),
    ).toEqual([ids.owned]);
    await t.mutation(api.albatrossWorkV2.reopenWork, { ...caller, workId });
    expect((await t.run((ctx) => ctx.db.get(ids.owned)))?.retiredAt).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(ids.done)))?.completedAt).toBe(2);
    expect((await t.run((ctx) => ctx.db.get(ids.projectId)))?.status).toBe('active');
  });

  test('brief composition excludes terminal owners of queued applications', () => {
    const context = buildAlbatrossDailyReportContextFromLive({
      workStates: [{ id: 'monro', workState: 'done', status: 'planning' }],
      applications: [
        {
          intentId: 'monro',
          intentText: 'Inflate the tire',
          status: 'queued',
          artifacts: [],
          unresolvedArtifacts: [],
          pendingApprovalIds: [],
          operationIds: [],
        },
      ],
    } as any);
    expect(context.activeIntents).toEqual([]);
  });

  test('resolves the exact composite mail shape and rejects conflicting or missing accounts before writes', () => {
    const evidence = {
      sourceKind: 'mail_thread',
      sourceId: 'mail:account-1:thread-1',
      title: 'Monro booking',
    };
    expect(progressEvidenceSchema.parse(evidence)).toMatchObject({
      accountId: 'account-1',
      sourceId: 'thread-1',
      trust: 'observed',
    });
    expect(progressEvidenceSchema.safeParse({ ...evidence, accountId: 'different' }).success).toBe(false);
    expect(progressEvidenceSchema.safeParse({ ...evidence, sourceId: 'thread-1' }).success).toBe(false);
    expect(progressEvidenceSchema.safeParse({ ...evidence, trust: 'reported' }).success).toBe(false);
  });
});

describe('interrupted deck execution', () => {
  test('a successful write replays its saved result and recovery reads only this owner and run', async () => {
    const t = harness();
    const input = {
      userId: caller.userId,
      runId: 'saved-turn',
      name: 'document_edit',
      args: { documentId: 'saved' },
      mutating: true,
    };
    const deps = {
      convexMutation: ((fn: any, args: any) =>
        t.mutation(fn, { ...args, internalSecret: caller.internalSecret })) as any,
    };
    let writes = 0;
    const save = async () => {
      writes++;
      return { status: 'applied', documentId: 'saved', revision: 5 };
    };
    expect(await executeCheckpointedTool(input, save, deps)).toEqual(
      await executeCheckpointedTool(input, save, deps),
    );
    expect(writes).toBe(1);
    const read = ((fn: any, args: any) =>
      t.query(fn, { ...args, internalSecret: caller.internalSecret })) as any;
    const context = await readRecoveryContext(caller.userId, input.runId, read);
    expect(context).toContain('"revision":5');
    expect(context).toContain('"status":"succeeded"');
    expect(await readRecoveryContext('another-user', input.runId, read)).toBe('');
    expect(await readRecoveryContext(caller.userId, 'another-turn', read)).toBe('');
  });

  test('oversized checkpoints retain document identity and revision without storing the entire model', () => {
    const output = {
      document: { documentId: 'deck', currentRevision: 5, title: 'Deck', model: 'x'.repeat(30_000) },
    };
    expect(checkpointOutput(output)).toMatchObject({
      outputOmitted: true,
      document: { documentId: 'deck', currentRevision: 5, title: 'Deck' },
    });
    expect(JSON.stringify(checkpointOutput(output)).length).toBeLessThan(1_000);
  });

  test('restyles all six slides without generating geometry or losing content', () => {
    const base = createDefaultDocumentModel('deck', 'deck');
    if (base.kind !== 'deck') throw new Error('deck required');
    base.slides = Array.from({ length: 6 }, (_, i) => ({
      ...structuredClone(base.slides[0]),
      id: `slide-${i}`,
    }));
    base.activeSlideId = 'slide-0';
    const styled: any = prepareDocumentEdits(base, [{ op: 'deck_restyle', theme: 'dark' }]);
    expect(styled.slides).toHaveLength(6);
    for (let i = 0; i < 6; i++) {
      expect(styled.slides[i].background).toBe('#111827');
      expect(styled.slides[i].elements.map((e: any) => [e.id, e.text, e.x, e.y, e.width, e.height])).toEqual(
        base.slides[i].elements.map((e) => [e.id, e.text, e.x, e.y, e.width, e.height]),
      );
    }
    const invalid = { ...base.slides[0].elements[0], y: -1 };
    expect(() =>
      prepareDocumentEdits(base, [{ op: 'element_upsert', slideId: 'slide-0', element: invalid }]),
    ).toThrow();
    expect(base.slides[0].background).not.toBe('#111827');
  });

  test('lost acknowledgement preserves the atomic revision and prevents replay', async () => {
    const t = harness();
    const runId = 'deck-turn';
    const documentId = 'deck-1';
    await t.mutation(api.documents.create, {
      ...caller,
      documentId,
      kind: 'deck',
      title: 'Deck',
      model: createDefaultDocumentModel('deck'),
    });
    const input = {
      userId: caller.userId,
      runId,
      name: 'document_edit',
      args: { documentId, expectedRevision: 1 },
      mutating: true,
    };
    const deps = {
      convexMutation: ((fn: any, args: any) =>
        t.mutation(fn, { ...args, internalSecret: caller.internalSecret })) as any,
    };
    let invoked = 0;
    const save = async (key: string) => {
      invoked++;
      await t.mutation(api.documents.update, {
        ...caller,
        documentId,
        expectedRevision: 1,
        title: 'Restyled',
        execution: { runId, key },
      });
      throw new Error('lost acknowledgement');
    };
    await expect(executeCheckpointedTool(input, save, deps)).rejects.toThrow('lost acknowledgement');
    await expect(executeCheckpointedTool(input, save, deps)).rejects.toThrow('already saved');
    expect(invoked).toBe(1);
    const records = await t.query(api.agentExecution.readRun, { ...caller, runId });
    expect(records[0]).toMatchObject({ status: 'unknown', effect: { documentId, revision: 2 } });
    expect(await t.query(api.agentExecution.readRun, { ...caller, userId: 'another-user', runId })).toEqual(
      [],
    );
    expect((await t.query(api.documents.get, { ...caller, documentId }))?.currentRevision).toBe(2);
  });

  test('concurrent claims and repeated successes execute once, independent user turns remain distinct', async () => {
    const t = harness();
    const key = toolExecutionKey('edit', { b: 2, a: 1 });
    expect(key).toBe(toolExecutionKey('edit', { a: 1, b: 2 }));
    const args = { ...caller, runId: 'turn', key, toolName: 'edit', mutating: true };
    const claims = await Promise.all([
      t.mutation(api.agentExecution.beginTool, args),
      t.mutation(api.agentExecution.beginTool, args),
    ]);
    expect(claims.filter((row) => row.claimed)).toHaveLength(1);
    await t.mutation(api.agentExecution.finishTool, {
      ...caller,
      runId: 'turn',
      key,
      status: 'succeeded',
      output: { revision: 2 },
    });
    expect(await t.mutation(api.agentExecution.beginTool, args)).toMatchObject({
      claimed: false,
      status: 'succeeded',
      output: { revision: 2 },
    });
    expect(await t.mutation(api.agentExecution.beginTool, { ...args, runId: 'new-turn' })).toMatchObject({
      claimed: true,
    });
  });

  test('a saved proposal is discoverable after a lost response and cannot be duplicated', async () => {
    const t = harness();
    const documentId = 'proposal-deck';
    const runId = 'proposal-turn';
    const key = 'proposal-key';
    const model = createDefaultDocumentModel('deck');
    await t.mutation(api.documents.create, { ...caller, documentId, kind: 'deck', title: 'Deck', model });
    await t.mutation(api.agentExecution.beginTool, {
      ...caller,
      runId,
      key,
      toolName: 'document_edit',
      mutating: true,
    });
    const proposal = {
      ...caller,
      documentId,
      title: 'Style',
      description: 'Style',
      proposedModel: model,
      execution: { runId, key },
    };
    await t.mutation(api.documents.createSuggestion, { ...proposal, suggestionId: 'first' });
    await expect(
      t.mutation(api.documents.createSuggestion, { ...proposal, suggestionId: 'second' }),
    ).rejects.toThrow('already committed');
    const doc = await t.query(api.documents.get, { ...caller, documentId });
    expect(doc?.suggestions).toHaveLength(1);
    expect(doc?.currentRevision).toBe(1);
    expect((await t.query(api.agentExecution.readRun, { ...caller, runId }))[0].effect).toEqual({
      documentId,
      suggestionId: 'first',
    });
  });
});
