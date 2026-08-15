import { api, convexMutation, convexQuery } from '../hosted/convex';

interface StepExecutionDependencies {
  convexMutation: typeof convexMutation;
  convexQuery: typeof convexQuery;
}

const defaults: StepExecutionDependencies = {
  convexMutation,
  convexQuery,
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

/**
 * Complete one named step immediately. The Convex mutation owns both Work
 * progress and any bound task card atomically; planning is never on this path.
 */
export async function completeWorkStep(
  input: CompleteWorkStepInput,
  deps: StepExecutionDependencies = defaults,
) {
  let stepKey = input.stepKey;
  if (!stepKey) {
    const detail = await deps.convexQuery<any>((api as any).albatrossWorkV2.workDetail, {
      userId: input.userId,
      workId: input.workId,
    });
    if (!detail?.work || !detail?.plan) throw new StepExecutionError('Albatross Work not found.', 404);
    stepKey = detail.execution?.currentStep?.key;
    if (!stepKey) throw new StepExecutionError('There is no current step to complete.', 409);
  }

  let completed: {
    stepKey: string;
    stepIdentity: string;
    stepTitle: string;
    planId: string;
    cardId: string | null;
    allStepsComplete: boolean;
    workState: string;
    transitioned: boolean;
  };
  try {
    completed = await deps.convexMutation((api as any).albatrossWorkV2.completeStep, {
      userId: input.userId,
      workId: input.workId,
      stepKey,
      source: input.source || 'user',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Work not found') || message.includes('does not have a plan')) {
      throw new StepExecutionError('Albatross Work not found.', 404);
    }
    if (message.includes('Plan step not found')) {
      throw new StepExecutionError('There is no current step to complete.', 409);
    }
    throw error;
  }

  return {
    ...completed,
    closed: completed.workState === 'done',
    replanned: false,
    // Final-step evidence is an atomic outbox write in completeStep. The
    // conductor materializes proof and handles planning after this returns.
    followUp:
      completed.transitioned &&
      completed.allStepsComplete &&
      !['done', 'released', 'archived'].includes(completed.workState)
        ? ('queued' as const)
        : ('not_needed' as const),
  };
}
