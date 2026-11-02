// One model call of a run, as a stream. The run reads the same result as
// generateText gives: the text, the steps, and the usage. In addition, the
// runner sees each text delta, so the user reads the text while the model
// writes it, and each chunk, so a stalled first call can end early.
//
// streamText reports a failed call to onError and does not throw, so this
// throws that error at the end. The failover and the retry rules of the runner
// then work as they do with generateText.
//
// A model step can stay busy and do nothing useful: one step wrote 12,000 tokens
// of tool arguments in 400 s and made no call. The provider idle limit never
// fires, because bytes arrive. So each model step has its own limit. The clock
// stops when the model finishes a tool call, so a slow tool does not count. The
// SDK `timeout.stepMs` also runs while a tool runs, so it cannot do this.

import { streamText } from 'ai';

/** A model step went past its limit. */
export class RunModelStepStall extends Error {
  constructor(timeoutMs: number) {
    super(`A model step ran for ${Math.round(timeoutMs / 1000)} s and did not finish.`);
    this.name = 'RunModelStepStall';
  }
}

export type RunModelOptions = Parameters<typeof streamText>[0] & {
  onTextDelta?: (delta: string) => void;
  /** Any chunk from the model. */
  onActivity?: () => void;
  /** The longest time the model can write in one step. With no value, no limit. */
  stepTimeoutMs?: number;
};

/** The chunks that show the model still writes in this step. */
const MODEL_WRITES = new Set(['text-delta', 'reasoning-delta', 'tool-input-start', 'tool-input-delta']);

export async function streamRunModel(options: RunModelOptions) {
  const { onTextDelta, onActivity, stepTimeoutMs, ...call } = options;
  let failure: unknown;
  const stepStall = new AbortController();
  let stepTimer: ReturnType<typeof setTimeout> | null = null;
  const startClock = () => {
    if (!stepTimeoutMs || stepTimer) return;
    stepTimer = setTimeout(() => stepStall.abort(new RunModelStepStall(stepTimeoutMs)), stepTimeoutMs);
    (stepTimer as { unref?: () => void }).unref?.();
  };
  const stopClock = () => {
    if (stepTimer) clearTimeout(stepTimer);
    stepTimer = null;
  };
  const stopped = call.abortSignal ? AbortSignal.any([call.abortSignal, stepStall.signal]) : stepStall.signal;
  try {
    const result = streamText({
      ...call,
      abortSignal: stopped,
      // The clock of a step starts after the runner's own work for that step.
      prepareStep: async (input: any) => {
        const prepared = await (call.prepareStep as any)?.(input);
        startClock();
        return prepared;
      },
      onChunk: ({ chunk }) => {
        onActivity?.();
        if (chunk.type === 'text-delta') onTextDelta?.(chunk.text);
        if (chunk.type === 'tool-call') stopClock();
        else if (MODEL_WRITES.has(chunk.type)) startClock();
      },
      onStepFinish: (step: any) => {
        stopClock();
        return (call.onStepFinish as any)?.(step);
      },
      onError: ({ error }) => {
        failure = error;
      },
    } as Parameters<typeof streamText>[0]);
    await result.consumeStream();
    stopped.throwIfAborted();
    if (failure) throw failure;
    const [text, steps, usage, totalUsage] = await Promise.all([
      result.text,
      result.steps,
      result.usage,
      result.totalUsage,
    ]);
    return { text, steps, usage, totalUsage };
  } finally {
    stopClock();
  }
}

export type RunModelResult = Awaited<ReturnType<typeof streamRunModel>>;
