import { newOperationBatchId } from '../ai/operations';
import { api, convexMutation, convexQuery } from '../hosted/convex';
import { albatrossApplyIntentPlan } from '../tools/albatross';
import { invokeTool } from '../tools/registry';
import { generateAreaLivingBrief } from './area-living-brief';
import { type AdvanceTrigger, conductorVerdict } from './conductor-quiet';
import { generateIntentPlan } from './intent-plan';
import { appliedStepsFromApplyResult } from './work-model';
import { unappliedActions } from './work-v2';

interface WorkOrchestratorDependencies {
  convexMutation: typeof convexMutation;
  convexQuery: typeof convexQuery;
  generateIntentPlan: typeof generateIntentPlan;
  invokeTool: typeof invokeTool;
  newOperationBatchId: typeof newOperationBatchId;
  generateAreaLivingBrief: typeof generateAreaLivingBrief;
}

const defaultWorkOrchestratorDependencies: WorkOrchestratorDependencies = {
  convexMutation,
  convexQuery,
  generateIntentPlan,
  invokeTool,
  newOperationBatchId,
  generateAreaLivingBrief,
};

let workOrchestratorDependencies = defaultWorkOrchestratorDependencies;

export function setWorkOrchestratorDependenciesForTest(overrides: Partial<WorkOrchestratorDependencies>) {
  const previous = workOrchestratorDependencies;
  workOrchestratorDependencies = { ...previous, ...overrides };
  return () => {
    workOrchestratorDependencies = previous;
  };
}

export interface AdvanceWorkInput {
  userId: string;
  userEmail?: string | null;
  userName?: string | null;
  workId: string;
  timezone?: string;
  geo?: { latitude: number; longitude: number };
  /**
   * Who asked. `user` (default) always moves. `evidence` moves unless the
   * Work is dormant. `conductor` obeys the quiet rule: only Work the user
   * touched recently, or a wake returned, may move.
   */
  trigger?: AdvanceTrigger;
  nowMs?: number;
}

export async function advanceWork(input: AdvanceWorkInput) {
  const trigger = input.trigger ?? 'user';
  if (trigger !== 'user') {
    const current = await workOrchestratorDependencies.convexQuery<any>(
      (api as any).albatrossIntents.getIntentWorkbench,
      { userId: input.userId, intentId: input.workId },
    );
    const row = current?.intent;
    if (row) {
      const verdict = conductorVerdict(row, trigger, input.nowMs ?? Date.now());
      if (verdict !== 'move') return { status: verdict, workId: input.workId };
    }
  }
  await workOrchestratorDependencies.convexMutation((api as any).albatrossWorkV2.setAgentState, {
    userId: input.userId,
    workId: input.workId,
    agentState: 'researching',
  });
  try {
    const generated = await workOrchestratorDependencies.generateIntentPlan({
      userId: input.userId,
      userEmail: input.userEmail,
      userName: input.userName,
      intentId: input.workId,
      timezone: input.timezone,
      geo: input.geo,
    });
    // A shape without plans is ready as it is. The planner already set the
    // agent state to idle; there is no plan to apply and nothing to schedule.
    if (generated?.skipped) return { status: 'ready' as const, workId: input.workId, planId: undefined };
    const workbench = await workOrchestratorDependencies.convexQuery<any>(
      (api as any).albatrossIntents.getIntentWorkbench,
      {
        userId: input.userId,
        intentId: input.workId,
      },
    );
    const work = workbench.intent;
    const plan = workbench.plan;
    const firstOpen = (work.questions || []).find((question: any) => !question.answer);
    if (firstOpen) {
      const questionId = await workOrchestratorDependencies.convexMutation<string>(
        (api as any).albatrossWorkV2.upsertQuestion,
        {
          userId: input.userId,
          workId: input.workId,
          legacyQuestionId: firstOpen.id,
          kind: 'clarification',
          prompt: firstOpen.prompt,
          reason: 'This answer materially changes the plan or the artifacts Albatross will create.',
          options: (firstOpen.options || []).map((option: any) => ({
            id: option.id,
            label: option.title,
            description: option.detail,
          })),
          sourceRefs: plan?.sourceRefs || [],
        },
      );
      return { status: 'needs_input' as const, workId: input.workId, questionId, planId: plan?._id };
    }
    if (!plan) throw new Error('Planning returned no plan.');
    if (plan.status === 'applied') {
      await workOrchestratorDependencies.convexMutation((api as any).albatrossWorkV2.setAgentState, {
        userId: input.userId,
        workId: input.workId,
        agentState: 'idle',
        primaryProjectId: work.primaryProjectId,
      });
      return { status: 'ready' as const, workId: input.workId, planId: plan._id };
    }

    const applications = await workOrchestratorDependencies
      .convexQuery<any[]>((api as any).albatrossWork.listPlanApplications, {
        userId: input.userId,
        intentId: input.workId,
        limit: 100,
      })
      .catch(() => []);
    const pendingActions = unappliedActions(plan.digitalActions || [], applications);
    if (!pendingActions.length && (plan.digitalActions || []).length) {
      await workOrchestratorDependencies.convexMutation((api as any).albatrossIntents.markPlanApplied, {
        userId: input.userId,
        planId: String(plan._id),
        appliedSteps: [],
      });
      await workOrchestratorDependencies.convexMutation((api as any).albatrossWorkV2.setAgentState, {
        userId: input.userId,
        workId: input.workId,
        agentState: 'idle',
        primaryProjectId: work.primaryProjectId,
      });
      return { status: 'ready' as const, workId: input.workId, planId: plan._id };
    }

    await workOrchestratorDependencies.convexMutation((api as any).albatrossWorkV2.setAgentState, {
      userId: input.userId,
      workId: input.workId,
      agentState: 'applying',
    });
    const operationBatchId = workOrchestratorDependencies.newOperationBatchId();
    const result: any = await workOrchestratorDependencies.invokeTool(
      albatrossApplyIntentPlan,
      {
        intentId: String(work._id),
        intentText: work.rawText,
        intentTitle: work.title,
        areaId: work.primaryAreaId ? String(work.primaryAreaId) : work.areaId,
        existingProjectId: work.primaryProjectId ? String(work.primaryProjectId) : undefined,
        projectMode: work.primaryProjectId ? 'task_only' : 'auto',
        projectTitle: plan.proposedProjectTitle,
        operationBatchId,
        plan: {
          id: String(plan._id),
          intentId: String(work._id),
          outcome: plan.outcome,
          digitalActions: pendingActions,
          sourceRefs: plan.sourceRefs,
        },
      },
      {
        agent: 'ai',
        userId: input.userId,
        userEmail: input.userEmail,
        userName: input.userName,
        operationBatchId,
        userTimezone: input.timezone,
      },
    );
    const appliedSteps = appliedStepsFromApplyResult(result);
    await workOrchestratorDependencies.convexMutation((api as any).albatrossIntents.markPlanApplied, {
      userId: input.userId,
      planId: String(plan._id),
      applicationId: result.applicationId,
      appliedSteps,
    });
    await workOrchestratorDependencies.convexMutation((api as any).albatrossWorkV2.setAgentState, {
      userId: input.userId,
      workId: input.workId,
      agentState: 'idle',
      primaryProjectId: result.projectId || undefined,
    });
    const areaId = work.primaryAreaId ? String(work.primaryAreaId) : work.areaId;
    if (areaId) {
      void workOrchestratorDependencies
        .generateAreaLivingBrief({
          userId: input.userId,
          userEmail: input.userEmail,
          userName: input.userName,
          areaId,
        })
        .catch(() => undefined);
    }
    return {
      status: 'applied' as const,
      workId: input.workId,
      planId: String(plan._id),
      projectId: result.projectId,
      operationBatchId,
      operations: result.operations || [],
      approvals: result.approvals || [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await workOrchestratorDependencies
      .convexMutation((api as any).albatrossWorkV2.setAgentState, {
        userId: input.userId,
        workId: input.workId,
        agentState: 'error',
        error: message,
      })
      .catch(() => undefined);
    throw error;
  }
}
