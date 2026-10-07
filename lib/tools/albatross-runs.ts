import { z } from 'zod';
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

export const albatrossHandleStep = defineTool({
  name: 'albatross_handle_step',
  description:
    "Have Albatross do a step of an Albatross (a Work) in the background, pass the user's note to the step that is in progress, or stop it (stop: true). One call does the right thing: a run in progress gets the note; a step that waits on the user (a question, a sign-in, a final page) continues with the note; otherwise a new run starts. Call it when the user asks you to do the step ('go ahead', 'register me'), answers what a run asked, says they finished their part ('I signed in', 'I paid'), or changes how the run should work ('use the Monday class'). Put what the user said, in their words plus any fact you found, in note. Omit stepKey for the current step. Do not do a website step yourself and do not offer to email someone instead: the run fills web forms in the shared browser. Reply in one short sentence; the run reports its own progress.",
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
  }),
  output: z.object({
    ok: z.boolean(),
    action: z.enum(['started', 'resumed', 'steered', 'working', 'stopped']).optional(),
    runId: z.string().optional(),
    workId: z.string(),
    message: z.string(),
  }),
  async handler(args, ctx) {
    if (args.stop) {
      const stopped = await stopStepFromThread({ userId: userIdOf(ctx), workId: args.workId });
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
      const result = await handleStepFromThread({
        userId: userIdOf(ctx),
        workId: args.workId,
        stepKey: args.stepKey,
        note: args.note,
      });
      return {
        ok: true,
        action: result.action,
        runId: result.runId,
        workId: args.workId,
        message: ACTION_MESSAGE[result.action],
      };
    } catch (error) {
      if (error instanceof StepRunStartError)
        return { ok: false, workId: args.workId, message: error.message };
      throw error;
    }
  },
});
