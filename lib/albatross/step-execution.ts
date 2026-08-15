import { newOperationBatchId } from '../ai/operations';
import { api, convexMutation, convexQuery } from '../hosted/convex';
import { invokeTool } from '../tools/registry';
import { tasksUpdateCard } from '../tools/tasks';
import { advanceWork } from './work-orchestrator';

interface StepExecutionDependencies {
  convexMutation: typeof convexMutation;
  convexQuery: typeof convexQuery;
  invokeTool: typeof invokeTool;
  advanceWork: typeof advanceWork;
  newOperationBatchId: typeof newOperationBatchId;
}

const defaults: StepExecutionDependencies = {
  convexMutation,
  convexQuery,
  invokeTool,
  advanceWork,
  newOperationBatchId,
};

export interface CompleteWorkStepInput {
  userId: string;
  userEmail?: string | null;
  userName?: string | null;
  workId: string;
  stepKey?: string;
  timezone?: string;
  source?: 'user' | 'task' | 'evidence';
}

export class StepExecutionError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409,
  ) {
    super(message);
    this.name = 'StepExecutionError';
  }
}

/** Complete the current named step, keep its task artifact in sync, then close or replan. */
export async function completeWorkStep(
  input: CompleteWorkStepInput,
  deps: StepExecutionDependencies = defaults,
) {
  const detail = await deps.convexQuery<any>((api as any).albatrossWorkV2.workDetail, {
    userId: input.userId,
    workId: input.workId,
  });
  if (!detail?.work || !detail?.plan) throw new StepExecutionError('Albatross Work not found.', 404);
  const step = (detail.execution?.guideSteps || []).find(
    (row: any) => row.key === (input.stepKey || detail.execution?.currentStep?.key),
  );
  if (!step) throw new StepExecutionError('There is no current step to complete.', 409);

  const completed = await deps.convexMutation<{
    stepKey: string;
    cardId: string | null;
    allStepsComplete: boolean;
    transitioned: boolean;
  }>((api as any).albatrossWorkV2.completeStep, {
    userId: input.userId,
    workId: input.workId,
    stepKey: step.key,
    source: input.source || (step.cardId ? 'task' : 'user'),
  });

  if (completed.transitioned && completed.cardId) {
    await deps.invokeTool(
      tasksUpdateCard,
      { cardId: completed.cardId, completed: true },
      {
        agent: 'user',
        userId: input.userId,
        userEmail: input.userEmail,
        userName: input.userName,
        userTimezone: input.timezone,
        operationBatchId: deps.newOperationBatchId(),
      },
    );
  }

  if (!completed.transitioned) {
    return {
      ...completed,
      closed: detail.work.workState === 'done',
      replanned: false,
    };
  }

  let closed = false;
  let replanned = false;
  if (completed.allStepsComplete) {
    await deps.convexMutation((api as any).albatrossWorkV2.attachProof, {
      userId: input.userId,
      workId: input.workId,
      claim: `Every planned step is complete: ${step.title}`,
      title: `Completed ${step.title}`,
      summary: 'The user marked the final remaining plan step complete.',
      limits:
        'This confirms the plan actions, but an external outcome may still need its own reply or receipt.',
      sourceKind: step.cardId ? 'task' : 'manual',
      sourceId: step.cardId || `plan:${String(detail.plan._id)}:steps-complete`,
      trust: 'confirmed',
      settleContract: false,
    });
    const after = await deps.convexQuery<any>((api as any).albatrossWorkV2.workDetail, {
      userId: input.userId,
      workId: input.workId,
    });
    closed = after?.work?.workState === 'done';
  }
  // Completion is a state transition, not the end of the request. Rebuild the
  // plan after every surviving step so the next concrete move receives its
  // own instructions and calendar block. This also gives legacy plans without
  // outcome contracts a safe way forward instead of leaving them active with
  // no current step.
  if (!closed) {
    await deps.advanceWork({
      userId: input.userId,
      userEmail: input.userEmail,
      userName: input.userName,
      workId: input.workId,
      timezone: input.timezone,
    });
    replanned = true;
  }
  return { ...completed, closed, replanned };
}
