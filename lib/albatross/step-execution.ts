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

  if (!completed.transitioned) {
    return {
      ...completed,
      closed: completed.workState === 'done',
      replanned: false,
      followUp: 'not_needed' as const,
    };
  }

  let closed = completed.workState === 'done';
  if (completed.allStepsComplete) {
    await deps.convexMutation((api as any).albatrossWorkV2.attachProof, {
      userId: input.userId,
      workId: input.workId,
      claim: `Every planned step is complete: ${completed.stepTitle}`,
      title: `Completed ${completed.stepTitle}`,
      summary: 'The user marked the final remaining plan step complete.',
      limits:
        'This confirms the plan actions, but an external outcome may still need its own reply or receipt.',
      sourceKind: completed.cardId ? 'task' : 'manual',
      sourceId: completed.cardId || `plan:${completed.planId}:steps-complete`,
      trust: 'confirmed',
      settleContract: false,
    });
    const after = await deps.convexQuery<any>((api as any).albatrossWorkV2.workDetail, {
      userId: input.userId,
      workId: input.workId,
    });
    closed = after?.work?.workState === 'done';
  }
  return {
    ...completed,
    closed,
    replanned: false,
    // Final-step evidence sets lastEvidenceAt. The existing evidence conductor
    // handles any plan/outcome follow-up after this response has returned.
    followUp: completed.allStepsComplete && !closed ? ('queued' as const) : ('not_needed' as const),
  };
}
