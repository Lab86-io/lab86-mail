import { afterEach, expect, spyOn, test } from 'bun:test';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { MockLanguageModelV3 } from 'ai/test';
import * as gateway from '../lib/ai/gateway';
import { runAgent } from '../lib/ai/loop';
import * as narrative from '../lib/narrative/service';
import * as memories from '../lib/store/memories';

const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});

function model(...turns: LanguageModelV3StreamPart[][]) {
  let index = 0;
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          for (const part of turns[index++] ?? []) controller.enqueue(part);
          controller.close();
        },
      }),
    }),
  });
}

function textParts(text: string): LanguageModelV3StreamPart[] {
  return [
    { type: 'text-start', id: 'text' },
    { type: 'text-delta', id: 'text', delta: text },
    { type: 'text-end', id: 'text' },
  ];
}

function finish(reason: 'stop' | 'tool-calls' = 'stop'): LanguageModelV3StreamPart {
  return {
    type: 'finish',
    finishReason: { unified: reason, raw: reason },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 2, text: 2, reasoning: 0 },
    },
  };
}

async function run(models: MockLanguageModelV3[], signal?: AbortSignal) {
  const runtimeSpy = spyOn(gateway, 'resolveAgentRuntimes').mockResolvedValue(
    models.map((model, index) => ({
      userId: 'owner',
      source: 'lab86',
      provider: 'openai',
      modelName: `model-${index}`,
      model,
    })),
  );
  const usage = spyOn(gateway, 'recordAgentUsage').mockResolvedValue(undefined);
  const context = spyOn(narrative, 'narrativePrompt').mockResolvedValue('');
  const memory = spyOn(memories, 'listMemories').mockResolvedValue([]);
  for (const spy of [runtimeSpy, usage, context, memory]) restores.push(() => spy.mockRestore());
  const agent = await runAgent({
    runId: 'deck-run',
    userId: 'owner',
    toolGroups: ['documents'],
    messages: [{ role: 'user', content: 'Restyle the deck' }],
    signal,
  });
  const response = agent.toUIMessageStreamResponse();
  expect(response.headers.get('x-agent-run-id')).toBe('deck-run');
  expect(response.headers.get('x-accel-buffering')).toBe('no');
  const events = (await response.text())
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice(6)));
  return { events, steps: await agent.steps, usage, runtimeSpy };
}

test('a rejected deck edit is a recoverable tool result, not a failed provider stream', async () => {
  const primary = model(
    [
      {
        type: 'tool-call',
        toolCallId: 'invalid-edit',
        toolName: 'document_edit',
        input: JSON.stringify({
          documentId: 'deck',
          expectedRevision: 4,
          operations: [
            {
              op: 'element_upsert',
              slideId: 'slide',
              element: {
                id: 'accent',
                type: 'shape',
                x: 0,
                y: -1,
                width: 50,
                height: 0,
              },
            },
          ],
        }),
      },
      finish('tool-calls'),
    ],
    [...textParts('The edit needs valid geometry.'), finish()],
  );
  const { events, usage, steps } = await run([primary]);
  expect(events).toContainEqual(
    expect.objectContaining({ type: 'tool-output-error', toolCallId: 'invalid-edit' }),
  );
  expect(events).toContainEqual({ type: 'finish', finishReason: 'stop' });
  expect(events.some((event) => event.type === 'error')).toBe(false);
  expect(primary.doStreamCalls).toHaveLength(2);
  expect(steps).toHaveLength(2);
  expect(usage.mock.calls[0][3]).toBe(true);
});

test('a fatal provider error after content preserves the partial turn and prevents runtime replay', async () => {
  const primary = model([
    ...textParts('I have read the deck.'),
    { type: 'error', error: Object.assign(new Error('provider disconnected'), { statusCode: 503 }) },
  ]);
  const fallback = model([...textParts('Do not replay this turn.'), finish()]);
  const { events, usage } = await run([primary, fallback]);
  expect(events).toContainEqual(
    expect.objectContaining({ type: 'text-delta', delta: 'I have read the deck.' }),
  );
  expect(events).toContainEqual({ type: 'error', errorText: 'provider disconnected' });
  expect(events).toContainEqual({ type: 'finish', finishReason: 'error' });
  expect(fallback.doStreamCalls).toHaveLength(0);
  expect(usage.mock.calls[0].slice(3)).toEqual([false, 'provider disconnected']);
});

test('a transient error before any content can safely fall back without leaking a failed turn', async () => {
  const primary = model([
    { type: 'error', error: Object.assign(new Error('upstream unavailable'), { statusCode: 503 }) },
  ]);
  const fallback = model([...textParts('The deck is ready to edit.'), finish()]);
  const { events, usage } = await run([primary, fallback]);
  expect(fallback.doStreamCalls).toHaveLength(1);
  expect(events.some((event) => event.type === 'error')).toBe(false);
  expect(events).toContainEqual({ type: 'finish', finishReason: 'stop' });
  expect(usage.mock.calls.map((call) => call[3])).toEqual([false, true]);
});

test('an already cancelled request never starts model generation', async () => {
  const controller = new AbortController();
  controller.abort();
  const primary = model([...textParts('Must not run.'), finish()]);
  const { events, runtimeSpy, steps } = await run([primary], controller.signal);
  expect(events).toContainEqual({ type: 'abort' });
  expect(runtimeSpy).not.toHaveBeenCalled();
  expect(primary.doStreamCalls).toHaveLength(0);
  expect(steps).toEqual([]);
});
