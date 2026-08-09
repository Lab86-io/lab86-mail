import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import schema from '../convex/schema';

const convexModules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/albatrossWorkV2.ts': () => import('../convex/albatrossWorkV2'),
  '../convex/albatrossIntents.ts': () => import('../convex/albatrossIntents'),
};

const SECRET = 'albatross-live-brief-runtime-secret';
const userId = 'live_brief_runtime_user';
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

function newHarness() {
  return convexTest(schema, convexModules);
}

async function seedWork(
  t: ReturnType<typeof newHarness>,
  overrides: Record<string, unknown> = {},
): Promise<Id<'albatrossIntents'>> {
  return t.run((ctx) => {
    const ts = Date.now();
    return ctx.db.insert('albatrossIntents', {
      userId,
      rawText: 'Renew the passport before the trip.',
      source: 'text',
      title: 'Renew the passport',
      status: 'ready',
      workState: 'active',
      agentState: 'idle',
      createdAt: ts,
      updatedAt: ts,
      ...overrides,
    });
  });
}

function gateDocument(questionId: string) {
  return {
    version: 2,
    title: 'Renew the passport',
    summary: 'The plan.',
    generatedAt: Date.now(),
    regions: [
      {
        id: 'steps',
        summary: 'The steps.',
        tree: {
          kind: 'checklist',
          title: 'Steps',
          items: [
            { label: 'Gather the documents', checked: false, stepKey: 'step-1' },
            { label: 'Book the appointment', checked: false, stepKey: 'step-2' },
          ],
        },
      },
      {
        id: 'frontier-gate',
        summary: 'One question is open.',
        tree: {
          kind: 'group',
          title: 'Answer this to continue',
          surface: 'elevated',
          emphasis: 'primary',
          tone: 'warning',
          collapsible: false,
          children: [
            {
              kind: 'prompt',
              variant: 'question',
              questionId,
              placeholder: 'Answer in your own words',
            },
          ],
        },
      },
    ],
  };
}

async function seedPlan(
  t: ReturnType<typeof newHarness>,
  workId: Id<'albatrossIntents'>,
  document: unknown,
): Promise<Id<'albatrossIntentPlans'>> {
  const planId = await t.run((ctx) => {
    const ts = Date.now();
    return ctx.db.insert('albatrossIntentPlans', {
      userId,
      intentId: workId,
      status: 'needs_answers',
      digitalActions: [],
      physicalActions: [],
      assumptions: [],
      sourceRefs: [],
      document,
      artifactSource: 'document-v2',
      createdAt: ts,
      updatedAt: ts,
    });
  });
  await t.run((ctx) => ctx.db.patch(workId, { latestPlanId: planId }));
  return planId;
}

describe('shape rides capture and planning', () => {
  test('finishCapture stores the splitter shape on the new work', async () => {
    const t = newHarness();
    const captureId = await t.run((ctx) => {
      const ts = Date.now();
      return ctx.db.insert('albatrossCaptures', {
        userId,
        rawText: 'renew my passport',
        source: 'text',
        status: 'processing',
        workIds: [],
        createdAt: ts,
        updatedAt: ts,
      });
    });
    const workIds = await t.mutation(api.albatrossWorkV2.finishCapture, {
      ...caller,
      captureId,
      items: [
        { title: 'Renew the passport', rawText: 'renew my passport', shape: 'quick' },
        { title: 'Untyped work', rawText: 'and something else' },
      ],
    });
    const works = await Promise.all(workIds.map((id) => t.run((ctx) => ctx.db.get(id))));
    expect(works[0]?.shape).toBe('quick');
    expect(works[1]?.shape).toBeUndefined();
  });

  test('savePlan refines shape and keeps the capture verdict when the planner offers none', async () => {
    const t = newHarness();
    const workId = await seedWork(t, { shape: 'quick' });
    const base = {
      ...caller,
      intentId: workId,
      outcome: 'The passport is renewed.',
      digitalActions: [],
      physicalActions: [],
      assumptions: [],
      sourceRefs: [],
    };
    await t.mutation(api.albatrossIntents.savePlan, { ...base, shape: 'project' });
    expect((await t.run((ctx) => ctx.db.get(workId)))?.shape).toBe('project');
    await t.mutation(api.albatrossIntents.savePlan, base);
    expect((await t.run((ctx) => ctx.db.get(workId)))?.shape).toBe('project');
  });
});

describe('the document binds to live records', () => {
  test('upsertQuestion rewrites the gate to the durable question id', async () => {
    const t = newHarness();
    const workId = await seedWork(t);
    const planId = await seedPlan(t, workId, gateDocument('q1'));
    const questionId = await t.mutation(api.albatrossWorkV2.upsertQuestion, {
      ...caller,
      workId,
      legacyQuestionId: 'q1',
      kind: 'clarification',
      prompt: 'Which office should handle the renewal?',
    });
    const plan = await t.run((ctx) => ctx.db.get(planId));
    const gate = (plan?.document as any).regions.at(-1);
    expect(gate.tree.children[0].questionId).toBe(String(questionId));
  });

  test('markPlanApplied binds keyed checklist items to their created cards', async () => {
    const t = newHarness();
    const workId = await seedWork(t);
    const planId = await seedPlan(t, workId, gateDocument('q1'));
    await t.mutation(api.albatrossIntents.markPlanApplied, {
      ...caller,
      planId,
      applicationId: 'app_1',
      appliedSteps: [
        { stepKey: 'step-1', kind: 'task', cardId: 'card_a' },
        { stepKey: 'step-2', kind: 'task' },
      ],
    });
    const plan = await t.run((ctx) => ctx.db.get(planId));
    const items = (plan?.document as any).regions[0].tree.items;
    expect(items[0].ref).toEqual({ kind: 'card', id: 'card_a' });
    expect(items[0].action).toMatchObject({ action: 'toggle_task', payload: { cardId: 'card_a' } });
    // A step applied without a card stays a plain item.
    expect(items[1].ref).toBeUndefined();
  });
});

describe('completion writes the record', () => {
  test('marking work done records shape, capture-to-done time, and no duplicate', async () => {
    const t = newHarness();
    const capturedAt = Date.now() - 90_000;
    const workId = await seedWork(t, { shape: 'quick', createdAt: capturedAt });
    await t.mutation(api.albatrossWorkV2.updateWorkState, { ...caller, workId, state: 'done' });
    // A second call in the done state must not double-record.
    await t.mutation(api.albatrossWorkV2.updateWorkState, { ...caller, workId, state: 'done' });
    const events = await t.run((ctx) => ctx.db.query('completionEvents').collect());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      artifactKind: 'intent',
      artifactId: String(workId),
      shape: 'quick',
    });
    expect(events[0].msToComplete).toBeGreaterThanOrEqual(90_000);
  });
});
