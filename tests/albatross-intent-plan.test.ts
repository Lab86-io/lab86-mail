import { describe, expect, test } from 'bun:test';
import { type PlanContextRef, parsePlanGeneration, resolveSourceRefs } from '../lib/albatross/intent-plan';

const validPlan = {
  title: 'Finish passport application',
  kind: 'obligation',
  priority: 1,
  areaName: null,
  projectTitle: null,
  outcome: 'A submitted passport application with confirmation number.',
  summary: 'You already have the form; what remains is photos, payment, and submission.',
  questions: [{ id: 'q1', prompt: 'Is this a renewal or a first passport?' }],
  digitalActions: [
    { kind: 'task', title: 'Get passport photos taken', priority: 2 },
    {
      kind: 'calendar_event',
      title: 'Passport paperwork hour',
      startIso: '2026-07-03T09:00:00Z',
      endIso: '2026-07-03T10:00:00Z',
    },
  ],
  physicalActions: [{ title: 'Bring documents to the post office', url: 'https://travel.state.gov' }],
  assumptions: ['You are applying from the US'],
  sourceRefIds: ['ref1'],
};

describe('parsePlanGeneration', () => {
  test('parses a clean JSON object', () => {
    const plan = parsePlanGeneration(JSON.stringify(validPlan));
    expect(plan.title).toBe('Finish passport application');
    expect(plan.digitalActions).toHaveLength(2);
    expect(plan.questions[0].prompt).toContain('renewal');
  });

  test('strips markdown fences and surrounding prose', () => {
    const raw = `Here is the plan you asked for:\n\`\`\`json\n${JSON.stringify(validPlan)}\n\`\`\`\nLet me know!`;
    const plan = parsePlanGeneration(raw);
    expect(plan.outcome).toContain('confirmation number');
  });

  test('repairs by dropping malformed array entries instead of failing the plan', () => {
    const damaged = {
      ...validPlan,
      digitalActions: [
        ...validPlan.digitalActions,
        { kind: 'email_send', title: 'Not an allowed generated kind' },
        { title: 'missing kind entirely' },
      ],
      questions: [...validPlan.questions, { prompt: '' }],
    };
    const plan = parsePlanGeneration(JSON.stringify(damaged));
    expect(plan.digitalActions).toHaveLength(2);
    expect(plan.questions).toHaveLength(1);
  });

  test('coerces unknown kind to "unknown" rather than failing', () => {
    const plan = parsePlanGeneration(JSON.stringify({ ...validPlan, kind: 'chore' }));
    expect(plan.kind).toBe('unknown');
  });

  test('throws when there is no JSON object at all', () => {
    expect(() => parsePlanGeneration('I could not make a plan, sorry.')).toThrow(/no JSON object/);
  });

  test('throws when required fields are missing after repair', () => {
    expect(() => parsePlanGeneration(JSON.stringify({ title: 'x' }))).toThrow(/failed validation/);
  });
});

describe('resolveSourceRefs', () => {
  const pack: PlanContextRef[] = [
    { refId: 'ref1', kind: 'mail_thread', id: 'thread-a', label: 'Passport receipt', accountId: 'acct1' },
    { refId: 'ref2', kind: 'mcp_item', id: 'issue-9', url: 'https://github.com/x/y/issues/9' },
  ];

  test('resolves only refs that exist in the context pack', () => {
    const refs = resolveSourceRefs(['ref2', 'ref-hallucinated', 'ref1'], pack);
    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({ kind: 'mcp_item', id: 'issue-9' });
    expect(refs[1]).toMatchObject({ kind: 'mail_thread', id: 'thread-a', accountId: 'acct1' });
  });

  test('dedupes repeated ref ids', () => {
    expect(resolveSourceRefs(['ref1', 'ref1', 'ref1'], pack)).toHaveLength(1);
  });

  test('handles undefined and empty inputs', () => {
    expect(resolveSourceRefs(undefined, pack)).toHaveLength(0);
    expect(resolveSourceRefs([], [])).toHaveLength(0);
  });
});
