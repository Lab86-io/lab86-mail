import { z } from 'zod';
import { StepExecutionError } from '../albatross/step-execution';
import { handleStepFromThread, StepRunStartError, stopStepFromThread } from '../albatross/step-run-start';
import { defineTool, type ToolContext } from './registry';

// The thread's control of step runs (docs/albatross-thread.md, "One voice,
// background runs"). The chat agent is the voice; a run does the work in the
// background and reports into the same conversation.

function userIdOf(ctx: ToolContext): string {
  if (!ctx.userId) throw new Error('Runs need a signed-in user.');
  return ctx.userId;
}

const ACTION_MESSAGE = {
  started: 'Albatross started on the step. The run shows its progress in this conversation.',
  resumed: 'Albatross continued the step with the note.',
  steered: 'The note went to the run that works now. It reads it before its next action.',
  working: 'Albatross already works on this step.',
} as const;

function checkedMessage(check: {
  allStepsComplete: boolean;
  nextRunId: string | null;
  nextStepKey: string | null;
}) {
  if (check.allStepsComplete) return 'Checked the step off. That was the last step of the plan.';
  if (check.nextRunId) return 'Checked the step off. Albatross started on the next step.';
  return 'Checked the step off. The next step is with the user.';
}

export const albatrossHandleStep = defineTool({
  name: 'albatross_handle_step',
  description:
    "Have Albatross do a step of an Albatross (a Work) in the background, pass the user's note to the step that is in progress, or stop it (stop: true). One call does the right thing: a run in progress gets the note; a step that waits on the user (a question, a sign-in, a final page) continues with the note; otherwise a new run starts. Call it when the user asks you to do the step ('go ahead', 'register me'), answers what a run asked, says they finished their part of a page ('I signed in', 'I paid'), or changes how the run should work ('use the Monday class'). When the user says a step is done ('this step is done', 'I filled in the hours', 'mark it done'), pass done: true: that checks the step off with their word and starts the next step; never resume a run to prove it again. Put what the user said, in their words plus any fact you found, in note. Omit stepKey for the current step. Do not do a website step yourself and do not offer to email someone instead: the run fills web forms in the shared browser. Reply in one short sentence; the run reports its own progress.",
  category: 'tasks',
  risk: 'write_self',
  mutating: true,
  input: z.object({
    workId: z.string().min(1).max(80),
    stepKey: z.string().min(1).max(300).optional(),
    note: z.string().max(2_000).optional(),
    stop: z
      .boolean()
      .optional()
      .describe('true only when the user asks to stop the run in progress. The page goes to the user.'),
    done: z
      .boolean()
      .optional()
      .describe(
        'true when the user says the step is done. Checks the step off with their word and starts the next step when Albatross can do it.',
      ),
  }),
  output: z.object({
    ok: z.boolean(),
    action: z.enum(['started', 'resumed', 'steered', 'working', 'stopped', 'checked']).optional(),
    runId: z.string().optional(),
    workId: z.string(),
    message: z.string(),
  }),
  handler: (args, ctx) => runHandleStep(args, ctx),
});

export interface HandleStepToolDependencies {
  handleStepFromThread: typeof handleStepFromThread;
  stopStepFromThread: typeof stopStepFromThread;
}

/** The handler of albatross_handle_step. The collaborators come in as arguments, so a test runs it in process. */
export async function runHandleStep(
  args: { workId: string; stepKey?: string; note?: string; stop?: boolean; done?: boolean },
  ctx: ToolContext,
  deps: HandleStepToolDependencies = { handleStepFromThread, stopStepFromThread },
) {
  if (args.stop) {
    const stopped = await deps.stopStepFromThread({ userId: userIdOf(ctx), workId: args.workId });
    return stopped
      ? {
          ok: true,
          action: 'stopped' as const,
          runId: stopped,
          workId: args.workId,
          message: 'Stopped the run. You have the page.',
        }
      : { ok: false, workId: args.workId, message: 'No run works on this Albatross now.' };
  }
  try {
    const result = await deps.handleStepFromThread({
      userId: userIdOf(ctx),
      workId: args.workId,
      stepKey: args.stepKey,
      note: args.note,
      done: args.done === true,
    });
    return {
      ok: true,
      action: result.action,
      ...(result.runId ? { runId: result.runId } : {}),
      workId: args.workId,
      message:
        result.action === 'checked' && result.check
          ? checkedMessage(result.check)
          : ACTION_MESSAGE[result.action as Exclude<typeof result.action, 'checked'>],
    };
  } catch (error) {
    if (error instanceof StepRunStartError || error instanceof StepExecutionError)
      return { ok: false, workId: args.workId, message: error.message };
    throw error;
  }
}
