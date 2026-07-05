import { describe, expect, test } from 'bun:test';
import seed from '../fixtures/albatross-0.9.seed.json';
import {
  buildAlbatrossDailyReportContext,
  buildAlbatrossDailyReportContextFromLive,
  loadLiveAlbatrossDailyReportContext,
} from '../lib/albatross/daily-report';
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

  test('plan step keys thread through to application steps (dossier card mapping)', () => {
    const plan = buildAlbatrossApplicationPlan({
      intentId: 'intent_tax',
      projectMode: 'task_only',
      account: 'jakob@example.test',
      plan: {
        digitalActions: [
          { kind: 'task', key: 'step-1', title: 'List missing tax documents' },
          {
            kind: 'email_send',
            key: 'step-2',
            title: 'Send accountant update',
            to: 'accountant@example.test',
            body: 'I am gathering the docs.',
          },
          { kind: 'task', title: 'Legacy action without a key' },
        ],
      },
    });
    expect(plan.executableSteps.find((step) => step.title.includes('missing'))?.stepKey).toBe('step-1');
    expect(plan.approvalSteps[0]?.stepKey).toBe('step-2');
    expect(plan.executableSteps.find((step) => step.title.includes('Legacy'))?.stepKey).toBeUndefined();
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
  test('defaults to empty context instead of seed data', () => {
    const context = buildAlbatrossDailyReportContext({
      now: Date.parse('2026-06-30T14:00:00.000Z'),
    });

    expect(context.activeIntents).toHaveLength(0);
    expect(context.activeProjects).toHaveLength(0);
    expect(context.includedAreas).toHaveLength(0);
  });

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

  test('builds daily report context from live Albatross work rows', () => {
    const context = buildAlbatrossDailyReportContextFromLive({
      now: Date.parse('2026-06-30T14:00:00.000Z'),
      projects: [
        {
          _id: 'project_live',
          title: 'Passport rescue',
          outcome: 'Renew without losing the trip.',
          areaId: 'area_trip',
          status: 'active',
          updatedAt: Date.parse('2026-06-30T12:00:00.000Z'),
        },
        {
          _id: 'project_done',
          title: 'Old paperwork',
          areaId: 'area_admin',
          status: 'done',
          completedAt: Date.parse('2026-06-29T12:00:00.000Z'),
        },
      ],
      approvals: [
        {
          _id: 'approval_live',
          title: 'Send passport appointment email',
          areaId: 'area_trip',
          status: 'pending',
          risk: 'Human-facing email',
        },
        {
          _id: 'approval_loud',
          title: 'Reply to CardHunt launch thread',
          areaId: 'area_cardhunt',
          status: 'claiming',
          risk: 'Human-facing reply',
        },
      ],
      applications: [
        {
          _id: 'application_live',
          intentId: 'intent_passport',
          intentText: 'Passport is a mess',
          areaId: 'area_trip',
          status: 'partially_applied',
          unresolvedArtifacts: [{ title: 'Choose renewal route', blockedReason: 'Needs route answer' }],
        },
      ],
      sprints: [
        {
          _id: 'sprint_live',
          title: 'Week of Jun 29',
          status: 'closed',
          closedAt: Date.parse('2026-06-30T13:00:00.000Z'),
        },
      ],
    });

    expect(context.activeProjects.map((project) => project.id)).toEqual(['project_live']);
    expect(context.activeIntents.map((intent) => intent.id)).toEqual(['intent_passport']);
    expect(context.includedAreas.map((area) => area.areaId)).toContain('area_trip');
    expect(context.askBeforeCentering.map((item) => item.areaId)).toContain('area_cardhunt');
    expect(context.askBeforeCentering.map((item) => item.areaId)).not.toContain('area_trip');
    expect(context.askBeforeCentering[0].prompt).toContain("Include it in today's report?");
    expect(context.contextReview.map((item) => item.id)).toContain('approval_live');
    expect(context.contextReview.map((item) => item.title)).toContain('Choose renewal route');
    expect(context.completions.map((event) => event.summary)).toContain('Closed sprint: Week of Jun 29');
    expect(context.completions.map((event) => event.summary)).toContain('Completed project: Old paperwork');
  });

  test('loads live daily report context through an injected query and falls back on errors', async () => {
    const loaded = await loadLiveAlbatrossDailyReportContext({
      userId: 'user_live',
      now: Date.parse('2026-06-30T14:00:00.000Z'),
      query: async (args) => {
        expect(args).toEqual({ userId: 'user_live', limit: 50 });
        return {
          projects: [
            {
              _id: 'project_live',
              title: 'Live project',
              areaId: 'area_live',
              status: 'active',
            },
          ],
        };
      },
    });

    expect(loaded.activeProjects.map((project) => project.title)).toEqual(['Live project']);

    const fallback = await loadLiveAlbatrossDailyReportContext({
      userId: 'user_live',
      now: Date.parse('2026-06-30T14:00:00.000Z'),
      query: async () => {
        throw new Error('Convex unavailable');
      },
    });
    expect(fallback.activeProjects).toHaveLength(0);
  });
});
