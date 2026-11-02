// One model call of a run, as a stream. The run reads the same result as
// generateText gives: the text, the steps, and the usage. In addition, the
// runner sees each text delta, so the user reads the text while the model
// writes it, and each chunk, so a stalled first call can end early.
//
// streamText reports a failed call to onError and does not throw, so this
// throws that error at the end. The failover and the retry rules of the runner
// then work as they do with generateText.

import { streamText } from 'ai';

export type RunModelOptions = Parameters<typeof streamText>[0] & {
  onTextDelta?: (delta: string) => void;
  /** Any chunk from the model. */
  onActivity?: () => void;
};

export async function streamRunModel(options: RunModelOptions) {
  const { onTextDelta, onActivity, ...call } = options;
  let failure: unknown;
  const result = streamText({
    ...call,
    onChunk: ({ chunk }) => {
      onActivity?.();
      if (chunk.type === 'text-delta') onTextDelta?.(chunk.text);
    },
    onError: ({ error }) => {
      failure = error;
    },
  } as Parameters<typeof streamText>[0]);
  await result.consumeStream();
  if (failure) throw failure;
  options.abortSignal?.throwIfAborted();
  const [text, steps, usage, totalUsage] = await Promise.all([
    result.text,
    result.steps,
    result.usage,
    result.totalUsage,
  ]);
  return { text, steps, usage, totalUsage };
}

export type RunModelResult = Awaited<ReturnType<typeof streamRunModel>>;
