import { afterEach, expect, spyOn, test } from 'bun:test';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { UIMessage } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import * as gateway from '../lib/ai/gateway';
import { runAgent } from '../lib/ai/loop';
import * as narrative from '../lib/narrative/service';
import * as memories from '../lib/store/memories';

// A Work thread reply runs to its end on the server when the browser leaves
// (docs/albatross-threads.md, T5): the response stream is cancelled at once,
// and the reply still finishes and reaches onFinish with a stable message id.

const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});

function slowModel(text: string) {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        async start(controller) {
          controller.enqueue({ type: 'text-start', id: 'text' });
          for (const word of text.split(' ')) {
            await new Promise((resolve) => setTimeout(resolve, 5));
            controller.enqueue({ type: 'text-delta', id: 'text', delta: `${word} ` });
          }
          controller.enqueue({ type: 'text-end', id: 'text' });
          controller.enqueue({
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 4, text: 4, reasoning: 0 },
            },
          });
          controller.close();
        },
      }),
    }),
  });
}

async function agent(text: string) {
  const runtime = spyOn(gateway, 'resolveAgentRuntimes').mockResolvedValue([
    {
      userId: 'owner',
      source: 'lab86',
      provider: 'openai',
      modelName: 'model-0',
      model: slowModel(text),
    } as any,
  ]);
  const usage = spyOn(gateway, 'recordAgentUsage').mockResolvedValue(undefined);
  const context = spyOn(narrative, 'narrativePrompt').mockResolvedValue('');
  const memory = spyOn(memories, 'listMemories').mockResolvedValue([]);
  for (const spy of [runtime, usage, context, memory]) restores.push(() => spy.mockRestore());
  return runAgent({
    runId: 'thread-run',
    userId: 'owner',
    toolGroups: [],
    messages: [{ role: 'user', content: 'Book the Monday class' }],
  });
}

const original: UIMessage[] = [
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Book the Monday class' }] } as UIMessage,
];

test('a cancelled response still finishes the reply and saves it', async () => {
  const run = await agent('I booked the Monday class for you.');
  let finished: { messages: UIMessage[]; responseMessage: UIMessage; isAborted: boolean } | null = null;
  const done = new Promise<void>((resolve) => {
    const response = run.toUIMessageStreamResponse({
      originalMessages: original,
      keepAlive: true,
      onFinish: (event) => {
        finished = event;
        resolve();
      },
    });
    // The browser leaves before it reads a byte.
    void response.body?.cancel();
  });
  await done;
  const event = finished as unknown as {
    messages: UIMessage[];
    responseMessage: UIMessage;
    isAborted: boolean;
  };
  expect(event.isAborted).toBe(false);
  expect(event.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
  expect(event.responseMessage.id).toBeTruthy();
  const text = event.responseMessage.parts
    .filter((part: any) => part.type === 'text')
    .map((part: any) => part.text)
    .join('');
  expect(text.trim()).toBe('I booked the Monday class for you.');
  expect(await run.steps).toHaveLength(1);
});

test('a failing save is logged and does not break the stream', async () => {
  const run = await agent('Done.');
  const errors = spyOn(console, 'error').mockImplementation(() => undefined);
  restores.push(() => errors.mockRestore());
  const response = run.toUIMessageStreamResponse({
    originalMessages: original,
    onFinish: () => {
      throw new Error('save failed');
    },
  });
  const body = await response.text();
  expect(body).toContain('"type":"finish"');
  expect(errors.mock.calls.some((call) => String(call[0]).includes('reply save failed'))).toBe(true);
});

test('without a model key and without a user, the agent explains instead of starting', async () => {
  const platform = spyOn(gateway, 'hasPlatformAi').mockReturnValue(false);
  restores.push(() => platform.mockRestore());
  await expect(runAgent({ runId: 'no-key', messages: [{ role: 'user', content: 'Hello' }] })).rejects.toThrow(
    /Models are not configured/,
  );
});
