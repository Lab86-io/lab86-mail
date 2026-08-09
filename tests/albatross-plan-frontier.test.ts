import { describe, expect, test } from 'bun:test';
import {
  appendFrontierGate,
  bindFrontierQuestionId,
  bindPlanDocumentSteps,
  FRONTIER_GATE_REGION_ID,
  frontierGateRegion,
  hasFrontierGate,
} from '@/lib/albatross/plan-frontier';
import { type BriefDocumentV2, parseBriefDocument } from '@/lib/shared/brief-document';

const WORK_ID = 'work123';

function baseDocument(regionCount = 1): BriefDocumentV2 {
  return parseBriefDocument({
    version: 2,
    title: 'Renew the passport',
    summary: 'A plan to renew the passport before the trip.',
    generatedAt: 1_700_000_000_000,
    regions: Array.from({ length: regionCount }, (_, index) => ({
      id: `region-${index + 1}`,
      summary: `Section ${index + 1} of the plan.`,
      tree: { kind: 'text', role: 'body', text: `Section ${index + 1}.` },
    })),
  });
}

const question = {
  id: 'q1',
  prompt: 'Which office should handle the renewal?',
  options: [
    { id: 'q1o1', title: 'Rochester passport office', address: '100 State St', hoursText: '9-5' },
    { id: 'q1o2', title: 'Buffalo passport office', detail: 'Farther, but has Saturday hours' },
  ],
};

const steps = [
  { key: 'step-1', title: 'Gather the documents' },
  { key: 'step-2', title: 'Book the appointment' },
];

describe('frontierGateRegion', () => {
  test('renders options as a decision with answer_question actions plus a free-text prompt', () => {
    const region = frontierGateRegion({ workId: WORK_ID, question, steps });
    expect(region.id).toBe(FRONTIER_GATE_REGION_ID);
    const group = region.tree as any;
    expect(group.kind).toBe('group');
    const kinds = group.children.map((child: any) => child.kind);
    expect(kinds).toEqual(['decision', 'prompt', 'checklist']);
    const decision = group.children[0];
    expect(decision.options).toHaveLength(2);
    expect(decision.options[0].action.action).toBe('answer_question');
    expect(decision.options[0].action.payload).toMatchObject({
      questionId: 'q1',
      answeredOptionId: 'q1o1',
      text: 'Rochester passport office',
    });
    expect(decision.options[0].description).toContain('100 State St');
    const prompt = group.children[1];
    expect(prompt.questionId).toBe('q1');
    const checklist = group.children[2];
    expect(checklist.items.map((item: any) => item.stepKey)).toEqual(['step-1', 'step-2']);
  });

  test('falls back to plain text plus prompt when a question has no real options', () => {
    const region = frontierGateRegion({
      workId: WORK_ID,
      question: { id: 'q2', prompt: 'What total amount do you want to put in?' },
    });
    const kinds = (region.tree as any).children.map((child: any) => child.kind);
    expect(kinds).toEqual(['text', 'prompt']);
  });

  test('omits the outline checklist when there are no steps', () => {
    const region = frontierGateRegion({ workId: WORK_ID, question });
    const kinds = (region.tree as any).children.map((child: any) => child.kind);
    expect(kinds).toEqual(['decision', 'prompt']);
  });
});

describe('appendFrontierGate', () => {
  test('appends a valid gate region that survives a full document parse', () => {
    const document = appendFrontierGate(baseDocument(), { workId: WORK_ID, question, steps });
    expect(document.regions).toHaveLength(2);
    expect(document.regions.at(-1)?.id).toBe(FRONTIER_GATE_REGION_ID);
    expect(hasFrontierGate(document, 'q1')).toBe(true);
  });

  test('replaces an earlier gate instead of stacking a second one', () => {
    const once = appendFrontierGate(baseDocument(), { workId: WORK_ID, question, steps });
    const twice = appendFrontierGate(once, {
      workId: WORK_ID,
      question: { id: 'q9', prompt: 'A newer question?' },
    });
    const gates = twice.regions.filter((region) => region.id === FRONTIER_GATE_REGION_ID);
    expect(gates).toHaveLength(1);
    expect(hasFrontierGate(twice, 'q9')).toBe(true);
    expect(hasFrontierGate(twice, 'q1')).toBe(false);
  });

  test('respects the 12-region document cap', () => {
    const document = appendFrontierGate(baseDocument(12), { workId: WORK_ID, question });
    expect(document.regions.length).toBeLessThanOrEqual(12);
    expect(document.regions.at(-1)?.id).toBe(FRONTIER_GATE_REGION_ID);
  });
});

describe('hasFrontierGate', () => {
  test('is false for documents without a gate, malformed documents, and null', () => {
    expect(hasFrontierGate(baseDocument())).toBe(false);
    expect(hasFrontierGate(null)).toBe(false);
    expect(hasFrontierGate({ regions: 'nope' })).toBe(false);
  });

  test('a gate region without a valid tree ends the walk instead of throwing', () => {
    const broken = { regions: [{ id: 'frontier-gate', summary: 'x', tree: null }] };
    expect(hasFrontierGate(broken)).toBe(true);
    expect(hasFrontierGate(broken, 'q1')).toBe(false);
    const alsoBroken = { regions: [{ id: 'frontier-gate', summary: 'x', tree: 'not-a-node' }] };
    expect(hasFrontierGate(alsoBroken, 'q1')).toBe(false);
  });
});

describe('bindFrontierQuestionId', () => {
  test('rewrites the prompt questionId and every decision payload to the durable id', () => {
    const document = appendFrontierGate(baseDocument(), { workId: WORK_ID, question, steps });
    const { document: bound, changed } = bindFrontierQuestionId(document, 'q1', 'durable42');
    expect(changed).toBe(true);
    expect(hasFrontierGate(bound, 'durable42')).toBe(true);
    const gate: any = (bound as BriefDocumentV2).regions.at(-1);
    const decision = gate.tree.children[0];
    for (const option of decision.options) {
      expect(option.action.payload.questionId).toBe('durable42');
    }
    // The original document is untouched.
    expect(hasFrontierGate(document, 'q1')).toBe(true);
  });

  test('reports no change when the id is absent or already durable', () => {
    const document = appendFrontierGate(baseDocument(), { workId: WORK_ID, question });
    expect(bindFrontierQuestionId(document, 'missing', 'durable').changed).toBe(false);
    expect(bindFrontierQuestionId(document, 'same', 'same').changed).toBe(false);
    expect(bindFrontierQuestionId(null, 'a', 'b').changed).toBe(false);
  });
});

describe('bindPlanDocumentSteps', () => {
  test('binds checklist items to cards and makes them live toggles', () => {
    const document = parseBriefDocument({
      version: 2,
      title: 'Plan',
      summary: 'A plan.',
      generatedAt: 1_700_000_000_000,
      regions: [
        {
          id: 'steps',
          summary: 'The steps.',
          tree: {
            kind: 'checklist',
            title: 'Steps',
            items: [
              { label: 'Gather documents', stepKey: 'step-1' },
              { label: 'Book appointment', stepKey: 'step-2' },
              { label: 'No step key here' },
            ],
          },
        },
      ],
    });
    const { document: bound, bound: count } = bindPlanDocumentSteps(document, [
      { stepKey: 'step-1', cardId: 'card-a' },
      { stepKey: 'step-2' }, // applied without a card — stays unbound
    ]);
    expect(count).toBe(1);
    const items: any[] = (bound as any).regions[0].tree.items;
    expect(items[0].ref).toEqual({ kind: 'card', id: 'card-a' });
    expect(items[0].action).toMatchObject({ action: 'toggle_task', payload: { cardId: 'card-a' } });
    expect(items[1].ref).toBeUndefined();
    expect(items[2].action).toBeUndefined();
  });

  test('binds items inside nested containers', () => {
    const document = appendFrontierGate(baseDocument(), { workId: WORK_ID, question, steps });
    const { bound: count } = bindPlanDocumentSteps(document, [{ stepKey: 'step-2', cardId: 'card-b' }]);
    expect(count).toBe(1);
  });

  test('does nothing without card mappings or a document', () => {
    expect(bindPlanDocumentSteps(null, [{ stepKey: 'step-1', cardId: 'c' }]).bound).toBe(0);
    expect(bindPlanDocumentSteps(baseDocument(), []).bound).toBe(0);
  });
});
