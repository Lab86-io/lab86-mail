import { describe, expect, test } from 'bun:test';
import { advanceWork, setWorkOrchestratorDependenciesForTest } from '../lib/albatross/work-orchestrator';

const input = {
  userId: 'user_1',
  userEmail: 'owner@example.test',
  userName: 'Owner',
  workId: 'work_1',
  timezone: 'America/New_York',
};

function harness(workbench: any, options: { applications?: any[]; applyResult?: any } = {}) {
  const mutations: any[] = [];
  let queryIndex = 0;
  let areaBriefs = 0;
  const restore = setWorkOrchestratorDependenciesForTest({
    convexMutation: (async (_ref: unknown, args: any) => {
      mutations.push(args);
      return args.legacyQuestionId ? 'question_1' : undefined;
    }) as any,
    convexQuery: (async () => {
      queryIndex += 1;
      return queryIndex === 1 ? workbench : options.applications || [];
    }) as any,
    generateIntentPlan: (async () => undefined) as any,
    invokeTool: (async () =>
      options.applyResult || {
        applicationId: 'application_1',
        projectId: 'project_1',
        operations: [{ tool: 'tasks_create_card' }],
        approvals: [],
        taskIdsByStepKey: { step_1: 'card_1' },
      }) as any,
    newOperationBatchId: () => 'batch_1',
    generateAreaLivingBrief: (async () => {
      areaBriefs += 1;
      return {} as any;
    }) as any,
  });
  return { mutations, restore, areaBriefs: () => areaBriefs };
}

describe('advanceWork orchestration', () => {
  test('turns the first unanswered planning question into durable input', async () => {
    const state = harness({
      intent: {
        questions: [
          {
            id: 'legacy_q',
            prompt: 'Which launch?',
            options: [{ id: 'one', title: 'Public', detail: 'Everyone can see it' }],
          },
        ],
      },
      plan: { _id: 'plan_1', sourceRefs: [{ kind: 'manual_note', id: 'note_1' }] },
    });
    try {
      await expect(advanceWork(input)).resolves.toEqual({
        status: 'needs_input',
        workId: 'work_1',
        questionId: 'question_1',
        planId: 'plan_1',
      });
      expect(state.mutations.at(-1)).toMatchObject({
        legacyQuestionId: 'legacy_q',
        prompt: 'Which launch?',
      });
    } finally {
      state.restore();
    }
  });

  test('settles an already-applied plan without applying it again', async () => {
    const state = harness({
      intent: { questions: [], primaryProjectId: 'project_existing' },
      plan: { _id: 'plan_1', status: 'applied' },
    });
    try {
      await expect(advanceWork(input)).resolves.toEqual({
        status: 'ready',
        workId: 'work_1',
        planId: 'plan_1',
      });
      expect(state.mutations.at(-1)).toMatchObject({
        agentState: 'idle',
        primaryProjectId: 'project_existing',
      });
    } finally {
      state.restore();
    }
  });

  test('applies remaining actions, records the result, and refreshes the Area', async () => {
    const state = harness({
      intent: {
        _id: 'work_1',
        rawText: 'Ship the release',
        title: 'Ship release',
        questions: [],
        primaryAreaId: 'area_1',
      },
      plan: {
        _id: 'plan_1',
        status: 'ready',
        outcome: 'Released',
        digitalActions: [{ actionKey: 'step_1', kind: 'task', title: 'Deploy' }],
        sourceRefs: [],
        proposedProjectTitle: 'Release',
      },
    });
    try {
      const result = await advanceWork(input);
      expect(result).toMatchObject({
        status: 'applied',
        workId: 'work_1',
        planId: 'plan_1',
        projectId: 'project_1',
        operationBatchId: 'batch_1',
      });
      await Promise.resolve();
      expect(state.areaBriefs()).toBe(1);
      expect(state.mutations.some((mutation) => mutation.applicationId === 'application_1')).toBe(true);
      expect(state.mutations.at(-1)).toMatchObject({ agentState: 'idle', primaryProjectId: 'project_1' });
    } finally {
      state.restore();
    }
  });

  test('records an error state when planning returns no plan', async () => {
    const state = harness({ intent: { questions: [] }, plan: null });
    try {
      await expect(advanceWork(input)).rejects.toThrow('Planning returned no plan');
      expect(state.mutations.at(-1)).toMatchObject({
        agentState: 'error',
        error: 'Planning returned no plan.',
      });
    } finally {
      state.restore();
    }
  });
});

describe('Albatross never repeats an action it already took', () => {
  // The single failure that would make the product untrustworthy is doing a
  // real-world thing twice — sending the same email, booking the same slot.
  // When every digital action in a plan has already been applied, advancing
  // must settle to ready rather than run them again.
  test('a fully applied plan settles to ready without invoking any tool', async () => {
    let toolCalls = 0;
    const state = harness(
      {
        intent: { questions: [] },
        plan: {
          _id: 'plan_1',
          digitalActions: [
            { actionKey: 'step_1', key: 'step_1', kind: 'email_draft', title: 'Send the 1099' },
            { actionKey: 'step_2', key: 'step_2', kind: 'calendar_event', title: 'Hold the slot' },
          ],
        },
      },
      {
        applications: [
          {
            _id: 'application_1',
            planId: 'plan_1',
            // Applied work is recorded as artifacts keyed by actionKey — that
            // is the join unappliedActions uses to decide what is left.
            artifacts: [{ actionKey: 'step_1' }, { actionKey: 'step_2' }],
          },
        ],
      },
    );
    const restoreTool = setWorkOrchestratorDependenciesForTest({
      invokeTool: (async () => {
        toolCalls += 1;
        return {};
      }) as any,
    });
    try {
      const result = await advanceWork(input);
      expect(result.status).toBe('ready');
      expect(result.workId).toBe('work_1');
      // Nothing was executed a second time.
      expect(toolCalls).toBe(0);
      // The agent stops working rather than sitting in a busy state forever.
      const agentStates = state.mutations.filter((m) => m.agentState).map((m) => m.agentState);
      expect(agentStates).toContain('idle');
    } finally {
      restoreTool();
      state.restore();
    }
  });
});
