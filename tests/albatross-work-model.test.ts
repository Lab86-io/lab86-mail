import { describe, expect, test } from 'bun:test';
import seed from '../fixtures/albatross-0.9.seed.json';
import {
  buildAlbatrossDailyReportContext,
  buildAlbatrossDailyReportContextFromLive,
  loadLiveAlbatrossDailyReportContext,
  prioritizeHandoffsForIntent,
} from '../lib/albatross/daily-report';
import {
  appliedStepsFromApplyResult,
  buildAlbatrossApplicationPlan,
  unresolvedArtifactsAfterUndo,
} from '../lib/albatross/work-model';

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

  test('auto mode derives a project (epic) from a multi-step plan: 3+ tasks', () => {
    const plan = buildAlbatrossApplicationPlan({
      intentId: 'intent_move',
      intentText: 'we are moving to rochester in september',
      intentTitle: 'Plan the Rochester move',
      projectMode: 'auto',
      plan: {
        outcome: 'The move is planned end to end.',
        digitalActions: [
          { kind: 'task', key: 'step-1', title: 'Book movers' },
          { kind: 'task', key: 'step-2', title: 'Give landlord notice' },
          { kind: 'task', key: 'step-3', title: 'Change address everywhere' },
        ],
      },
    });
    expect(plan.projectRequired).toBe(true);
    // The intent's short title names the derived epic — no model projectTitle needed.
    expect(plan.projectTitle).toBe('Plan the Rochester move');
    expect(plan.executableSteps[0]).toMatchObject({ kind: 'project', title: 'Plan the Rochester move' });
    expect(plan.executableSteps.filter((step) => step.kind === 'task')).toHaveLength(3);
  });

  test('auto mode derives a project when any action is scheduled beyond a week out', () => {
    const now = Date.parse('2026-07-07T12:00:00.000Z');
    const plan = buildAlbatrossApplicationPlan({
      intentId: 'intent_horizon',
      intentText: 'renew passport before the fall trip',
      projectMode: 'auto',
      account: 'jakob@example.test',
      now,
      plan: {
        digitalActions: [
          { kind: 'task', title: 'Fill out DS-82' },
          {
            kind: 'calendar_event',
            title: 'Passport photo appointment',
            startIso: '2026-07-20T15:00:00.000Z',
            endIso: '2026-07-20T15:30:00.000Z',
          },
        ],
      },
    });
    expect(plan.projectRequired).toBe(true);
    // No intentTitle: the raw intent text names the epic.
    expect(plan.projectTitle).toBe('renew passport before the fall trip');
  });

  test('auto mode keeps single-errand plans task-only (1-2 near-term actions, no project)', () => {
    const now = Date.parse('2026-07-07T12:00:00.000Z');
    const plan = buildAlbatrossApplicationPlan({
      intentId: 'intent_errand',
      intentText: 'drop off the dry cleaning',
      intentTitle: 'Drop off dry cleaning',
      projectMode: 'auto',
      account: 'jakob@example.test',
      now,
      plan: {
        digitalActions: [
          { kind: 'task', title: 'Drop off dry cleaning' },
          {
            kind: 'calendar_event',
            title: 'Dry cleaning run',
            startIso: '2026-07-08T15:00:00.000Z',
            endIso: '2026-07-08T15:30:00.000Z',
          },
        ],
      },
    });
    expect(plan.projectRequired).toBe(false);
    expect(plan.projectTitle).toBeUndefined();
    expect(plan.executableSteps.map((step) => step.kind)).toEqual(['task', 'calendar_event']);
  });

  test('projectMode "project" always creates the epic, even without any declared title', () => {
    const plan = buildAlbatrossApplicationPlan({
      intentId: 'intent_forced',
      intentText: 'sort out the insurance mess',
      projectMode: 'project',
      plan: { digitalActions: [{ kind: 'task', title: 'Call the insurer' }] },
    });
    expect(plan.projectRequired).toBe(true);
    expect(plan.projectTitle).toBe('sort out the insurance mess');
    expect(plan.executableSteps[0].kind).toBe('project');
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

  test('appliedSteps mapping records cardId for tasks, eventId for events, draftId for drafts, and bare keys for approvals', () => {
    const steps = appliedStepsFromApplyResult({
      operations: [
        {
          stepKey: 'step-1',
          kind: 'task',
          tool: 'tasks_create_card',
          artifactId: 'card_1',
        },
        {
          stepKey: 'step-2',
          kind: 'calendar_event',
          tool: 'calendar_create_event',
          artifactId: 'evt_1',
        },
        { stepKey: 'step-3', kind: 'email_draft', tool: 'save_draft', artifactId: 'draft_1' },
        // Legacy operation without a stepKey never produces a mapping row.
        { kind: 'task', tool: 'tasks_create_card', artifactId: 'card_orphan' },
      ],
      approvals: [{ stepKey: 'step-4', kind: 'email_send' }],
    });
    expect(steps).toEqual([
      { stepKey: 'step-1', kind: 'task', cardId: 'card_1' },
      { stepKey: 'step-2', kind: 'calendar_event', eventId: 'evt_1' },
      { stepKey: 'step-3', kind: 'email_draft', draftId: 'draft_1' },
      { stepKey: 'step-4', kind: 'email_send' },
    ]);
  });

  test('appliedSteps mapping tolerates missing artifact ids and empty results', () => {
    expect(appliedStepsFromApplyResult({})).toEqual([]);
    expect(
      appliedStepsFromApplyResult({
        operations: [{ stepKey: 'step-1', kind: 'task', tool: 'tasks_create_card' }],
      }),
    ).toEqual([{ stepKey: 'step-1', kind: 'task' }]);
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
      checkins: [
        {
          localDate: '2026-06-29',
          responseText: 'Shipped the billing fix.',
          tomorrowIntentText: 'Renew the passport and confirm the trip.',
          updatedAt: Date.parse('2026-06-30T01:00:00.000Z'),
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
    expect(context.dailyAlignment).toEqual({
      localDate: '2026-06-29',
      reflection: 'Shipped the billing fix.',
      tomorrowIntent: 'Renew the passport and confirm the trip.',
    });
  });

  test('uses tomorrow intent as a stable ordering overlay for SBAR handoffs', () => {
    const handoff = (id: string, situation: string) =>
      ({
        id,
        situation,
        assessment: situation,
        recommendation: situation,
        background: [],
        evidence: [],
        items: [],
      }) as any;
    const original = [
      handoff('billing', 'Review the billing launch'),
      handoff('passport', 'Renew the passport before the trip'),
      handoff('calendar', 'Clean up the calendar'),
    ];

    expect(
      prioritizeHandoffsForIntent(original, 'Tomorrow I want to finish passport renewal').map(
        (item) => item.id,
      ),
    ).toEqual(['passport', 'billing', 'calendar']);
    expect(prioritizeHandoffsForIntent(original, undefined).map((item) => item.id)).toEqual([
      'billing',
      'passport',
      'calendar',
    ]);
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
