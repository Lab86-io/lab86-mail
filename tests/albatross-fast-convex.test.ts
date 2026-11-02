import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import schema from '../convex/schema';
import { createDefaultDocumentModel } from '../lib/documents/model';
import { parseBriefDocument } from '../lib/shared/brief-document';

// The reads and writes that make Albatross fast: the plan page that comes after
// the plan, the rail's own small queries, the thread's detail without the page,
// the document revision, and an activity answer that does not move by itself.

const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/agentExecution.ts': () => import('../convex/agentExecution'),
  '../convex/albatross.ts': () => import('../convex/albatross'),
  '../convex/albatrossBrowserSessions.ts': () => import('../convex/albatrossBrowserSessions'),
  '../convex/albatrossIntents.ts': () => import('../convex/albatrossIntents'),
  '../convex/albatrossNotifications.ts': () => import('../convex/albatrossNotifications'),
  '../convex/albatrossStepRuns.ts': () => import('../convex/albatrossStepRuns'),
  '../convex/albatrossThreads.ts': () => import('../convex/albatrossThreads'),
  '../convex/albatrossWork.ts': () => import('../convex/albatrossWork'),
  '../convex/albatrossWorkV2.ts': () => import('../convex/albatrossWorkV2'),
  '../convex/boards.ts': () => import('../convex/boards'),
  '../convex/documents.ts': () => import('../convex/documents'),
  '../convex/mobile.ts': () => import('../convex/mobile'),
  '../convex/narrative.ts': () => import('../convex/narrative'),
};

const SECRET = 'albatross-fast-secret';
const userId = 'fast_user';
const caller = { internalSecret: SECRET, userId };
let previous: string | undefined;
beforeAll(() => {
  previous = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});
afterAll(() => {
  if (previous === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previous;
});

const harness = () => convexTest(schema, modules);
type Harness = ReturnType<typeof harness>;

const seedWork = (t: Harness, overrides: Record<string, unknown> = {}) =>
  t.run((ctx) =>
    ctx.db.insert('albatrossIntents', {
      userId,
      rawText: 'Send the proposal to Dana',
      title: 'Proposal',
      source: 'text',
      status: 'ready',
      workState: 'active',
      agentState: 'idle',
      createdAt: 1,
      updatedAt: 1,
      ...overrides,
    } as any),
  );

const savePlan = (t: Harness, intentId: Id<'albatrossIntents'>, extra: Record<string, unknown> = {}) =>
  t.mutation(api.albatrossIntents.savePlan, {
    ...caller,
    intentId,
    outcome: 'Dana has the proposal',
    digitalActions: [{ key: 'step-1', actionKey: 'write', kind: 'task', title: 'Write the proposal' }],
    physicalActions: [],
    assumptions: [],
    sourceRefs: [],
    ...extra,
  });

const page = () =>
  parseBriefDocument({
    version: 2,
    title: 'Plan',
    summary: 'The plan page.',
    generatedAt: 1,
    regions: [
      {
        id: 'steps',
        summary: 'Steps',
        tree: { kind: 'checklist', title: 'Steps', items: [{ label: 'Write', stepKey: 'step-1' }] },
      },
    ],
  });

const planRow = (t: Harness, planId: unknown) => t.run((ctx) => ctx.db.get(planId as any)) as Promise<any>;

describe('the plan page comes after the plan', () => {
  test('a saved plan waits for its page until a time, and the page ends the wait', async () => {
    const t = harness();
    const intentId = await seedWork(t);
    const before = Date.now();
    const planId = await savePlan(t, intentId, { documentPending: true, artifactHtml: '<p>plan</p>' });
    const saved = await planRow(t, planId);
    expect(saved.documentPendingUntil).toBeGreaterThan(before + 60_000);
    expect(saved.document).toBeUndefined();
    expect(saved.status).toBe('ready');

    expect(
      await t.mutation(api.albatrossIntents.attachPlanDocument, {
        ...caller,
        planId,
        document: page(),
        artifactSource: 'document-v2',
      }),
    ).toBe(true);
    const attached = await planRow(t, planId);
    expect(attached.artifactSource).toBe('document-v2');
    expect(attached.document.regions[0].id).toBe('steps');
    expect(attached.documentPendingUntil).toBeUndefined();
  });

  test('a plan saved with no pending page has no wait', async () => {
    const t = harness();
    const planId = await savePlan(t, await seedWork(t));
    expect((await planRow(t, planId)).documentPendingUntil).toBeUndefined();
  });

  test('a page that comes after apply binds its checklist to the cards', async () => {
    const t = harness();
    const intentId = await seedWork(t);
    const planId = await savePlan(t, intentId, { documentPending: true });
    await t.mutation(api.albatrossIntents.markPlanApplied, {
      ...caller,
      planId,
      appliedSteps: [{ stepKey: 'step-1', kind: 'task', cardId: 'card_1' }],
    });
    await t.mutation(api.albatrossIntents.attachPlanDocument, {
      ...caller,
      planId,
      document: page(),
      artifactSource: 'document-v2',
    });
    const item = (await planRow(t, planId)).document.regions[0].tree.items[0];
    expect(item.ref).toEqual({ kind: 'card', id: 'card_1' });
    expect(item.action.action).toBe('toggle_task');
    expect((await planRow(t, planId)).status).toBe('applied');
  });

  test('a failed composer ends the wait and keeps the plan', async () => {
    const t = harness();
    const planId = await savePlan(t, await seedWork(t), { documentPending: true, artifactHtml: '<p>x</p>' });
    expect(await t.mutation(api.albatrossIntents.attachPlanDocument, { ...caller, planId })).toBe(false);
    const row = await planRow(t, planId);
    expect(row.documentPendingUntil).toBeUndefined();
    expect(row.documentFailedAt).toBeGreaterThan(0);
    expect(row.artifactHtml).toBe('<p>x</p>');
    expect(row.outcome).toBe('Dana has the proposal');
  });

  test('a page for a plan that a newer plan replaced does nothing', async () => {
    const t = harness();
    const intentId = await seedWork(t);
    const old = await savePlan(t, intentId, { documentPending: true });
    await savePlan(t, intentId);
    expect(
      await t.mutation(api.albatrossIntents.attachPlanDocument, {
        ...caller,
        planId: old,
        document: page(),
        artifactSource: 'document-v2',
      }),
    ).toBe(false);
    expect((await planRow(t, old)).document).toBeUndefined();
  });

  test('only the server attaches a page', async () => {
    const t = harness();
    const planId = await savePlan(t, await seedWork(t));
    await expect(
      t.withIdentity({ subject: userId }).mutation(api.albatrossIntents.attachPlanDocument, { planId }),
    ).rejects.toThrow('Only the server');
  });
});

describe('the thread detail without the plan page', () => {
  async function planned(t: Harness) {
    const intentId = await seedWork(t);
    const planId = await savePlan(t, intentId, { artifactHtml: '<p>page</p>', documentPending: true });
    await t.mutation(api.albatrossIntents.attachPlanDocument, {
      ...caller,
      planId,
      document: page(),
      artifactSource: 'document-v2',
    });
    return { intentId, planId };
  }

  test('the web thread leaves the page out, and every other field stays', async () => {
    const t = harness();
    const { intentId } = await planned(t);
    const lite = await t.query(api.albatrossWorkV2.workDetail, {
      ...caller,
      workId: intentId,
      omitPlanArtifact: true,
    });
    expect(lite!.plan).not.toHaveProperty('artifactHtml');
    expect(lite!.plan).not.toHaveProperty('document');
    expect(lite!.plan!.artifactSource).toBe('document-v2');
    expect(lite!.plan!.outcome).toBe('Dana has the proposal');
  });

  test('a caller that does not ask gets the whole plan: the shape of the mobile clients stays', async () => {
    const t = harness();
    const { intentId } = await planned(t);
    const whole = await t.query(api.albatrossWorkV2.workDetail, { ...caller, workId: intentId });
    expect(whole!.plan!.artifactHtml).toBe('<p>page</p>');
    expect((whole!.plan!.document as any).regions).toHaveLength(1);
  });

  test('the optional read gives the page when Details opens', async () => {
    const t = harness();
    const { planId } = await planned(t);
    const artifact = await t.query(api.albatrossIntents.getPlanArtifact, { ...caller, planId });
    expect(artifact.artifactHtml).toBe('<p>page</p>');
    expect((artifact.document as any).regions).toHaveLength(1);
  });
});

describe('the rail reads only what it shows', () => {
  async function seedArea(t: Harness, overrides: Record<string, unknown> = {}) {
    return t.run((ctx) =>
      ctx.db.insert('areas', {
        userId,
        name: 'Taxes',
        kind: 'admin',
        status: 'active',
        createdAt: 1,
        updatedAt: 1,
        ...overrides,
      } as any),
    );
  }

  test('railAreas gives names and icons, in the same order as the overview', async () => {
    const t = harness();
    await seedArea(t, { name: 'Zoo', priority: 1, primaryDomain: 'zoo.example' });
    await seedArea(t, { name: 'Apps', priority: 2 });
    await seedArea(t, { name: 'Bakery', priority: 2 });
    await seedArea(t, { name: 'Old', status: 'archived' });
    const rows = await t.query(api.albatross.railAreas, caller);
    expect(rows.map((row) => row.name)).toEqual(['Zoo', 'Apps', 'Bakery']);
    expect(rows[0].faviconUrl).toContain('zoo.example');
    expect(rows[1]).not.toHaveProperty('workCounts');
    const overview = await t.query(api.albatross.listAreasOverview, { ...caller, status: 'active' });
    expect(overview.map((row) => row.name)).toEqual(rows.map((row) => row.name));
    expect(overview[0].faviconUrl).toBe(rows[0].faviconUrl);
  });

  test('an area with no stored domain takes its icon from its own facts, as the overview does', async () => {
    const t = harness();
    const areaId = await seedArea(t);
    await t.run((ctx) =>
      ctx.db.insert('areaFacts', {
        userId,
        areaId,
        kind: 'website',
        value: 'tax.ny.gov',
        status: 'verified',
        sourceRefs: [],
        confirmationRefs: [],
        createdAt: 1,
        updatedAt: 1,
      } as any),
    );
    const [row] = await t.query(api.albatross.railAreas, caller);
    const [full] = await t.query(api.albatross.listAreasOverview, { ...caller, status: 'active' });
    expect(row.faviconUrl).toContain('tax.ny.gov');
    expect(row.faviconUrl).toBe(full.faviconUrl);
    expect(row.primaryDomain).toBe(full.primaryDomain);
  });

  test('the badge count agrees with the rule on the Work list', async () => {
    const t = harness();
    const asking = await seedWork(t, { title: 'Asks' });
    await t.mutation(api.albatrossWorkV2.upsertQuestion, {
      ...caller,
      workId: asking,
      kind: 'clarification',
      prompt: 'Which one?',
      reason: 'It changes the plan.',
      sourceRefs: [],
    } as any);
    await seedWork(t, { title: 'Failed plan', planError: 'It stopped.' });
    await seedWork(t, { title: 'Fine' });
    await seedWork(t, { title: 'Closed with a question', workState: 'done', status: 'done', planError: 'x' });
    await seedWork(t, {
      title: 'Watched',
      workState: 'waiting',
      replyWatch: {
        id: 'watch_1',
        accountId: 'acct_1',
        threadId: 'thread_1',
        senderEmails: ['dana@example.test'],
        requirement: 'A reply',
        after: 1,
        startedAt: 1,
      },
      planError: 'x',
    });
    expect(await t.query(api.albatrossWorkV2.railNeedsYouCount, caller)).toEqual({ needsYou: 2 });
    const { needsYou } = await import('../lib/albatross/work-state');
    const rows = await t.query(api.albatrossWorkV2.allWork, caller);
    expect(rows.filter((row) => needsYou(row)).length).toBe(2);
  });
});

describe('the answers that used to move by themselves', () => {
  test('activity gives the same answer after a heartbeat, so the client gets no update', async () => {
    const t = harness();
    const workId = String(await seedWork(t));
    const { runId } = await t.mutation(api.albatrossStepRuns.enqueue, {
      ...caller,
      workId,
      stepKey: 'step-1',
      stepIdentity: 'step:one',
      stepTitle: 'One',
      trigger: 'user',
    });
    const fence = { ...caller, id: runId as Id<'albatrossStepRuns'>, token: 'tok' };
    await t.mutation(api.albatrossStepRuns.claim, fence);
    const before = await t.query(api.albatrossThreads.activity, caller);
    expect(before).not.toHaveProperty('now');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await t.mutation(api.albatrossStepRuns.heartbeat, fence);
    await t.mutation(api.albatrossStepRuns.progress, { ...fence, liveText: 'Some words' });
    const after = await t.query(api.albatrossThreads.activity, caller);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  test('a log line does change the answer', async () => {
    const t = harness();
    const workId = String(await seedWork(t));
    const { runId } = await t.mutation(api.albatrossStepRuns.enqueue, {
      ...caller,
      workId,
      stepKey: 'step-1',
      stepIdentity: 'step:one',
      stepTitle: 'One',
      trigger: 'user',
    });
    const fence = { ...caller, id: runId as Id<'albatrossStepRuns'>, token: 'tok' };
    await t.mutation(api.albatrossStepRuns.claim, fence);
    await t.mutation(api.albatrossStepRuns.progress, {
      ...fence,
      lines: [{ key: 'call', text: 'Reads irs.gov.', open: true }],
    });
    const activity = await t.query(api.albatrossThreads.activity, caller);
    expect(activity.runs[workId].logLine).toBe('Reads irs.gov.');
  });
});

describe('the saved revision of a document', () => {
  const documentId = 'doc_fast';
  const create = (t: Harness) =>
    t.mutation(api.documents.create, {
      ...caller,
      documentId,
      kind: 'doc',
      title: 'Invoice',
      model: createDefaultDocumentModel('doc', 'Invoice'),
    });

  test('the owner reads the revision, and a save moves it', async () => {
    const t = harness();
    await create(t);
    const owner = t.withIdentity({ subject: userId });
    expect(await owner.query(api.documents.savedRevision, { documentId })).toBe(1);
    await t.mutation(api.documents.update, {
      ...caller,
      documentId,
      expectedRevision: 1,
      title: 'Invoice 2',
      reason: 'test',
    } as any);
    expect(await owner.query(api.documents.savedRevision, { documentId })).toBe(2);
  });

  test('with no user, or for another user, the answer is null: the editor keeps its fallback', async () => {
    const t = harness();
    await create(t);
    expect(await t.query(api.documents.savedRevision, { documentId })).toBeNull();
    expect(
      await t.withIdentity({ subject: 'intruder' }).query(api.documents.savedRevision, { documentId }),
    ).toBeNull();
    expect(
      await t.withIdentity({ subject: userId }).query(api.documents.savedRevision, { documentId: 'none' }),
    ).toBeNull();
  });
});
