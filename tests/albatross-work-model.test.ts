import { describe, expect, test } from 'bun:test';
import seed from '../fixtures/albatross-0.9.seed.json';
import { buildAlbatrossDailyReportContext } from '../lib/albatross/daily-report';
import { buildAlbatrossApplicationPlan, unresolvedArtifactsAfterUndo } from '../lib/albatross/work-model';

describe('Albatross plan application model', () => {
  test('separates executable artifacts, approval-gated actions, and unresolved actions', () => {
    const plan = buildAlbatrossApplicationPlan({
      intentId: 'intent_tax',
      intentText: 'Need to file taxes',
      areaId: 'area_money',
      account: 'jakob@example.test',
      projectMode: 'auto',
      plan: {
        id: 'plan_tax',
        outcome: 'Know what remains and block the next work session.',
        proposedArtifacts: [{ kind: 'project', title: 'Tax filing cleanup' }],
        digitalActions: [
          { kind: 'task', title: 'List missing tax documents', priority: 1 },
          {
            kind: 'email_send',
            title: 'Send accountant update',
            to: 'accountant@example.test',
            subject: 'Tax docs',
            body: 'I am gathering the docs.',
          },
          { kind: 'calendar_event', title: 'Tax cleanup hold' },
        ],
      },
    });

    expect(plan.projectRequired).toBe(true);
    expect(plan.executableSteps.map((step) => step.kind)).toEqual(['project', 'task']);
    expect(plan.approvalSteps.map((step) => step.kind)).toEqual(['email_send']);
    expect(plan.unresolved).toHaveLength(1);
    expect(plan.unresolved[0].blockedReason).toContain('Calendar start and end');
  });

  test('undone operations reappear as unresolved artifacts', () => {
    const unresolved = unresolvedArtifactsAfterUndo(
      {
        artifacts: [
          { kind: 'task', id: 'card_1', title: 'List missing tax documents' },
          { kind: 'emailDraft', id: 'draft_1', title: 'Draft Andrew note' },
        ],
      },
      [
        { status: 'undone', target: { kind: 'task', id: 'card_1' } },
        { status: 'applied', target: { kind: 'emailDraft', id: 'draft_1' } },
      ],
    );

    expect(unresolved).toEqual([{ kind: 'task', id: 'card_1', title: 'List missing tax documents' }]);
  });

  test('source refs dedupe by kind and id together', () => {
    const plan = buildAlbatrossApplicationPlan({
      intentId: 'intent_same_ref_id',
      plan: {
        digitalActions: [
          {
            kind: 'task',
            title: 'Preserve both evidence refs',
            sourceRefs: [{ kind: 'mailThread', id: 'same-id' }],
          },
        ],
        sourceRefs: [
          { kind: 'intent', id: 'same-id' },
          { kind: 'mailThread', id: 'same-id' },
        ],
      },
    });

    expect(plan.executableSteps[0].sourceRefs).toEqual([
      { kind: 'mailThread', id: 'same-id' },
      { kind: 'intent', id: 'same-id' },
    ]);
  });
});

describe('Albatross Daily Report context', () => {
  test('asks before centering loud unknown areas while keeping declared intents visible', () => {
    const context = buildAlbatrossDailyReportContext({
      now: Date.parse('2026-06-30T14:00:00.000Z'),
      seedData: seed,
    });

    expect(context.askBeforeCentering.map((item) => item.areaId)).toContain('area_cardhunt');
    expect(context.askBeforeCentering[0].prompt).toContain('Include it?');
    expect(context.includedAreas.map((area) => area.areaId)).toContain('area_money');
    expect(context.activeIntents.some((intent) => intent.id === 'intent_taxes_panic')).toBe(true);
    expect(context.activeProjects.some((project) => project.id === 'project_cardhunt_launch')).toBe(false);
  });

  test('explicitly included loud areas can bring their active project into the report', () => {
    const context = buildAlbatrossDailyReportContext({
      now: Date.parse('2026-06-30T14:00:00.000Z'),
      includeAreaIds: ['area_cardhunt'],
      seedData: seed,
    });

    expect(context.askBeforeCentering.map((item) => item.areaId)).not.toContain('area_cardhunt');
    expect(context.activeProjects.map((project) => project.id)).toContain('project_cardhunt_launch');
  });

  test('first report of the month asks for a broader context review', () => {
    const context = buildAlbatrossDailyReportContext({
      now: Date.parse('2026-07-01T14:00:00.000Z'),
      seedData: seed,
      isFirstOpenOfMonth: true,
    });

    expect(context.monthlyPrompt).toContain('First report of the month');
  });

  test('does not infer monthly prompt from the calendar date alone', () => {
    const context = buildAlbatrossDailyReportContext({
      now: Date.parse('2026-07-01T14:00:00.000Z'),
      seedData: seed,
    });

    expect(context.monthlyPrompt).toBeUndefined();
  });
});
