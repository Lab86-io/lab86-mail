import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { ModelMessage } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import * as gateway from '../lib/ai/gateway';
import { forwardAgentStream, runAgent } from '../lib/ai/loop';
import { ProviderStreamIdleError, streamIdleTimeoutFetch } from '../lib/ai/provider-idle-timeout';
import { MAX_TOOL_RESULT_BYTES } from '../lib/ai/tool-result-cap';
import * as convex from '../lib/hosted/convex';
import * as narrative from '../lib/narrative/service';
import { TOOLS } from '../lib/tools';

const restores: Array<() => void> = [];
beforeEach(() => {
  for (const name of ['warn', 'error', 'info'] as const) {
    const spy = spyOn(console, name).mockImplementation(() => undefined);
    restores.push(() => spy.mockRestore());
  }
});
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});

type Turn = (controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>) => void;

function model(...turns: Turn[]) {
  let index = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      const turn = turns[index++];
      return { stream: new ReadableStream({ start: (controller) => turn?.(controller) }) };
    },
  });
}

function finish(reason: 'stop' | 'tool-calls' | 'length' = 'stop'): LanguageModelV3StreamPart {
  return {
    type: 'finish',
    finishReason: { unified: reason, raw: reason },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 2, text: 2, reasoning: 0 },
    },
  };
}

const answer =
  (value: string, reason: 'stop' | 'length' = 'stop'): Turn =>
  (controller) => {
    controller.enqueue({ type: 'text-start', id: 't' });
    controller.enqueue({ type: 'text-delta', id: 't', delta: value });
    controller.enqueue({ type: 'text-end', id: 't' });
    controller.enqueue(finish(reason));
    controller.close();
  };

const callTool =
  (toolName: string, input: unknown, toolCallId = 'call-1'): Turn =>
  (controller) => {
    controller.enqueue({ type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) });
    controller.enqueue(finish('tool-calls'));
    controller.close();
  };

const overloaded = () => Object.assign(new Error('Overloaded'), { statusCode: 503 });

const failsWith =
  (error: unknown): Turn =>
  (controller) => {
    controller.enqueue({ type: 'error', error });
    controller.close();
  };

async function run(
  models: MockLanguageModelV3[],
  options: {
    source?: string;
    messages?: ModelMessage[];
    extra?: Partial<Parameters<typeof runAgent>[0]>;
  } = {},
) {
  const failed: unknown[] = [];
  const runtimes = spyOn(gateway, 'resolveAgentRuntimes').mockResolvedValue(
    models.map((entry, index) => ({
      userId: 'owner',
      source: options.source ?? 'lab86',
      provider: 'openai',
      modelName: `model-${index}`,
      model: entry,
    })) as any,
  );
  const usage = spyOn(gateway, 'recordAgentUsage').mockImplementation(async (...args: any[]) => {
    if (args[3] === false) failed.push(args[4]);
  });
  const context = spyOn(narrative, 'narrativePrompt').mockResolvedValue('');
  const platform = spyOn(gateway, 'hasPlatformAi').mockReturnValue(true);
  for (const spy of [runtimes, usage, context, platform]) restores.push(() => spy.mockRestore());
  const agent = await runAgent({
    runId: 'failover-run',
    userId: null,
    messages: options.messages ?? [{ role: 'user', content: 'Find the lease.' }],
    ...options.extra,
  });
  const events = (await agent.toUIMessageStreamResponse().text())
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice(6)));
  return { events, steps: await agent.steps, failed };
}

function handlerSpy(name: string, value: unknown = { ok: true, threads: [] }) {
  const spy = spyOn(TOOLS[name], 'handler').mockResolvedValue(value as never);
  restores.push(() => spy.mockRestore());
  return spy;
}

const typesOf = (events: any[]) => events.map((event) => event.type);
const textOf = (events: any[]) =>
  events
    .filter((event) => event.type === 'text-delta')
    .map((event) => event.delta)
    .join('');
const promptOf = (mock: MockLanguageModelV3, call = 0) => JSON.stringify(mock.doStreamCalls[call].prompt);

describe('late failover', () => {
  test('a provider failure after a tool ran continues on the next runtime and runs no tool twice', async () => {
    const search = handlerSpy('search_threads', { ok: true, threads: ['lease-thread'] });
    const first = model(
      callTool('search_threads', { account: 'acct_1', query: 'lease' }),
      failsWith(overloaded()),
    );
    const second = model(answer('The lease is in the thread.'));
    const { events, steps, failed } = await run([first, second]);
    expect(search).toHaveBeenCalledTimes(1);
    // The next runtime reads the result and the note. The model does not ask for the tool again.
    const prompt = promptOf(second);
    expect(prompt).toContain('lease-thread');
    expect(prompt).toContain('The previous model failed during this turn');
    expect(textOf(events)).toBe('The lease is in the thread.');
    // The user sees a turn that went on, not an error.
    expect(typesOf(events)).not.toContain('error');
    expect(events.at(-1)).toEqual({ type: 'finish', finishReason: 'stop' });
    expect(failed).toEqual(['Overloaded']);
    // Post-turn work reads the steps of both runtimes.
    expect(steps.length).toBeGreaterThanOrEqual(2);
  });

  test('the hand-off drops reasoning from another provider', async () => {
    handlerSpy('search_threads');
    const first = model((controller) => {
      controller.enqueue({ type: 'reasoning-start', id: 'r' });
      controller.enqueue({ type: 'reasoning-delta', id: 'r', delta: 'SIGNED-REASONING' });
      controller.enqueue({ type: 'reasoning-end', id: 'r' });
      callTool('search_threads', { account: 'acct_1', query: 'lease' })(controller);
    }, failsWith(overloaded()));
    const second = model(answer('Done.'));
    await run([first, second]);
    expect(promptOf(second)).not.toContain('SIGNED-REASONING');
  });

  test('a stream that breaks after a tool ran hands off too, and closes the open text', async () => {
    const search = handlerSpy('search_threads');
    const first = model(callTool('search_threads', { account: 'acct_1', query: 'lease' }), (controller) => {
      controller.enqueue({ type: 'text-start', id: 'partial' });
      controller.enqueue({ type: 'text-delta', id: 'partial', delta: 'Half' });
      setTimeout(() => controller.error(new TypeError('terminated')), 5);
    });
    const second = model(answer('Whole answer.'));
    const { events } = await run([first, second]);
    expect(search).toHaveBeenCalledTimes(1);
    expect(textOf(events)).toBe('HalfWhole answer.');
    const closedAt = events.findIndex((event) => event.type === 'text-end' && event.id === 'partial');
    expect(closedAt).toBeGreaterThan(-1);
    expect(typesOf(events)).not.toContain('error');
    expect(events.at(-1)).toEqual({ type: 'finish', finishReason: 'stop' });
  });

  test('the prompt of the next runtime never ends with the partial text of the failed step', async () => {
    handlerSpy('search_threads');
    const first = model(callTool('search_threads', { account: 'acct_1', query: 'lease' }), (controller) => {
      controller.enqueue({ type: 'text-start', id: 't' });
      controller.enqueue({ type: 'text-delta', id: 't', delta: 'PARTIAL-TEXT' });
      controller.enqueue({ type: 'error', error: overloaded() });
      controller.close();
    });
    const second = model(answer('Whole answer.'));
    await run([first, second]);
    const { prompt } = second.doStreamCalls[0];
    expect(prompt.at(-1)?.role).toBe('tool');
    expect(JSON.stringify(prompt)).not.toContain('PARTIAL-TEXT');
  });

  test('the groups the failed runtime loaded stay loaded on the next one', async () => {
    const first = model(callTool('enable_tools', { groups: ['slack'] }), failsWith(overloaded()));
    const second = model(answer('Done.'));
    await run([first, second]);
    const names = (second.doStreamCalls[0].tools ?? []).map((entry: any) => entry.name);
    expect(names).toContain('slack_search');
  });

  test('a failure after reasoning alone hands off with the prompt it had', async () => {
    const first = model((controller) => {
      controller.enqueue({ type: 'reasoning-start', id: 'r' });
      controller.enqueue({ type: 'reasoning-delta', id: 'r', delta: 'Thinking' });
      controller.enqueue({ type: 'error', error: overloaded() });
      controller.close();
    });
    const second = model(answer('Answer.'));
    const { events } = await run([first, second]);
    expect(textOf(events)).toBe('Answer.');
    expect(typesOf(events)).not.toContain('error');
    expect(promptOf(second)).not.toContain('The previous model failed');
  });

  test('a failure after text with no tool stays an error with Continue, with no second answer', async () => {
    const first = model((controller) => {
      controller.enqueue({ type: 'text-start', id: 't' });
      controller.enqueue({ type: 'text-delta', id: 't', delta: 'Partial' });
      controller.enqueue({ type: 'error', error: overloaded() });
      controller.close();
    });
    const second = model(answer('Never sent.'));
    const { events } = await run([first, second]);
    expect(second.doStreamCalls).toHaveLength(0);
    expect(textOf(events)).toBe('Partial');
    expect(typesOf(events)).toContain('error');
    expect(events.at(-1)).toEqual({ type: 'finish', finishReason: 'error' });
  });

  test('a user key has no chain to fall to: the error stays', async () => {
    handlerSpy('search_threads');
    const first = model(
      callTool('search_threads', { account: 'acct_1', query: 'lease' }),
      failsWith(overloaded()),
    );
    const second = model(answer('Never sent.'));
    const { events } = await run([first, second], { source: 'user' });
    expect(second.doStreamCalls).toHaveLength(0);
    expect(typesOf(events)).toContain('error');
  });

  test('the last runtime reports the failure, and every runtime gets its one chance', async () => {
    const search = handlerSpy('search_threads');
    const first = model(
      callTool('search_threads', { account: 'acct_1', query: 'lease' }),
      failsWith(overloaded()),
    );
    const second = model(failsWith(overloaded()));
    const { events, failed } = await run([first, second]);
    expect(search).toHaveBeenCalledTimes(1);
    expect(second.doStreamCalls).toHaveLength(1);
    expect(events.filter((event) => event.type === 'error')).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: 'finish', finishReason: 'error' });
    expect(failed).toHaveLength(2);
  });

  test('a stop during the first runtime never starts the next one', async () => {
    const controller = new AbortController();
    handlerSpy('search_threads');
    const first = model(callTool('search_threads', { account: 'acct_1', query: 'lease' }), (stream) => {
      stream.enqueue({ type: 'text-start', id: 't' });
      stream.enqueue({ type: 'text-delta', id: 't', delta: 'Partial' });
      setTimeout(() => {
        controller.abort();
        stream.error(new TypeError('terminated'));
      }, 5);
    });
    const second = model(answer('Never sent.'));
    const { events } = await run([first, second], { extra: { signal: controller.signal } });
    expect(second.doStreamCalls).toHaveLength(0);
    expect(typesOf(events)).toContain('abort');
  });
});

describe('a stalled provider', () => {
  function stalledProvider() {
    const fetcher = streamIdleTimeoutFetch(
      (async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({
                    id: 'c',
                    object: 'chat.completion.chunk',
                    created: 1,
                    model: 'm',
                    choices: [
                      { index: 0, delta: { role: 'assistant', content: 'Partial' }, finish_reason: null },
                    ],
                  })}\n\n`,
                ),
              );
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )) as unknown as typeof fetch,
      30,
    );
    return createOpenAI({ apiKey: 'test-key', fetch: fetcher }).chat('stalled');
  }

  test('the turn ends with an error and Continue, without a press of Stop', async () => {
    const { events } = await run([stalledProvider() as any]);
    expect(textOf(events)).toBe('Partial');
    const error = events.find((event) => event.type === 'error');
    expect(error.errorText).toContain('sent nothing');
    expect(events.at(-1)).toEqual({ type: 'finish', finishReason: 'error' });
  });

  test('a stall before any content moves to the next runtime', async () => {
    const stalled = createOpenAI({
      apiKey: 'test-key',
      fetch: streamIdleTimeoutFetch((() => new Promise(() => undefined)) as unknown as typeof fetch, 20),
    }).chat('stalled');
    const second = model(answer('From the next model.'));
    const { events, failed } = await run([stalled as any, second]);
    expect(textOf(events)).toBe('From the next model.');
    expect(typesOf(events)).not.toContain('error');
    expect(String(failed[0])).toContain('sent nothing');
    expect(new ProviderStreamIdleError(1000).isRetryable).toBe(true);
  });
});

describe('a reply cut at the token cap', () => {
  test('text cut at the cap ends as a failure that offers Continue', async () => {
    const { events } = await run([model(answer('The first half', 'length'))]);
    const error = events.find((event) => event.type === 'error');
    expect(error.errorText).toBe(
      'The reply reached its length limit before it finished. Continue picks it up.',
    );
    expect(error.errorText).not.toMatch(/\bAI\b/);
    // The web chat offers Continue on the error, and native clients on the reason.
    expect(events.at(-1)).toEqual({ type: 'finish', finishReason: 'length' });
  });

  test('a large tool call cut at the cap never runs, and it offers Continue', async () => {
    const create = handlerSpy('document_create');
    const { events } = await run([
      model((controller) => {
        controller.enqueue({ type: 'tool-input-start', id: 'doc-1', toolName: 'document_create' });
        controller.enqueue({ type: 'tool-input-delta', id: 'doc-1', delta: '{"kind":"deck","title":"Half' });
        controller.enqueue(finish('length'));
        controller.close();
      }),
    ]);
    expect(create).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({ type: 'finish', finishReason: 'length' });
    expect(typesOf(events)).toContain('error');
  });

  test('a normal stop stays a plain stop', async () => {
    const { events } = await run([model(answer('Done.'))]);
    expect(typesOf(events)).not.toContain('error');
    expect(events.at(-1)).toEqual({ type: 'finish', finishReason: 'stop' });
  });
});

describe('what a tool result costs the model', () => {
  test('a large result reaches the model cut, with a note, and the client keeps the full output', async () => {
    const large = { ok: true, body: 'x'.repeat(MAX_TOOL_RESULT_BYTES * 2) };
    handlerSpy('search_threads', large);
    const mock = model(callTool('search_threads', { account: 'acct_1', query: 'lease' }), answer('Done.'));
    const { events } = await run([mock]);
    const prompt = promptOf(mock, 1);
    expect(prompt).toContain('This result was cut');
    expect(prompt.length).toBeLessThan(MAX_TOOL_RESULT_BYTES + 200_000);
    const output = events.find((event) => event.type === 'tool-output-available');
    expect(output.output.body).toHaveLength(MAX_TOOL_RESULT_BYTES * 2);
  });

  test('a resume keeps the group that the model loaded earlier in the chat', async () => {
    const mock = model(answer('Done.'));
    await run([mock], {
      messages: [
        { role: 'user', content: 'Search Slack.' },
        {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: 'e', toolName: 'enable_tools', input: { groups: ['slack'] } },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'e',
              toolName: 'enable_tools',
              output: { type: 'json', value: { ok: true } },
            },
          ],
        },
        { role: 'user', content: 'And the other channel?' },
      ],
    });
    const names = (mock.doStreamCalls[0].tools ?? []).map((entry: any) => entry.name);
    expect(names).toContain('slack_search');
    expect(names).not.toContain('create_smart_label');
  });

  test('a live presentation keeps its picker and its deck tools', async () => {
    const mock = model(answer('Done.'));
    await run([mock], { extra: { presentationSession: { presentationId: 'p1' } as any } });
    const names = (mock.doStreamCalls[0].tools ?? []).map((entry: any) => entry.name);
    expect(names).toContain('document_create');
    expect(names).toContain('presentation_plan');
  });

  test('a plain chat sends far fewer tools than the catalog', async () => {
    const mock = model(answer('Done.'));
    await run([mock]);
    const names = (mock.doStreamCalls[0].tools ?? []).map((entry: any) => entry.name);
    expect(names.length).toBeLessThanOrEqual(80);
    expect(names).toContain('enable_tools');
    expect(names).not.toContain('document_edit');
  });
});

describe('a write in a signed-in run', () => {
  const ARCHIVE = { account: 'acct_1', threadId: 't1' };
  const signedIn = { userId: 'owner', chatId: 'chat-1' };

  function checkpoints(claim: Record<string, unknown> = { claimed: true }, onBegin?: () => void) {
    const spy = spyOn(convex, 'convexMutation').mockImplementation((async (_fn: unknown, args: any) => {
      if (args.status) return null;
      onBegin?.();
      return claim;
    }) as never);
    restores.push(() => spy.mockRestore());
    const calls = () => spy.mock.calls.map((call) => call[1] as any);
    return {
      begin: () => calls().find((args) => args.toolName),
      finish: () => calls().find((args) => args.status),
    };
  }

  test('the checkpoint keeps the chat of the run, and a success stores its output', async () => {
    const archive = handlerSpy('archive_thread', { ok: true, operationId: 'op_1' });
    const rows = checkpoints();
    await run([model(callTool('archive_thread', ARCHIVE), answer('Done.'))], { extra: signedIn });
    expect(archive).toHaveBeenCalledTimes(1);
    expect(rows.begin()).toMatchObject({
      userId: 'owner',
      runId: 'failover-run',
      chatId: 'chat-1',
      toolName: 'archive_thread',
    });
    expect(rows.finish()).toMatchObject({ status: 'succeeded', output: { ok: true, operationId: 'op_1' } });
  });

  test('a call that says it failed stores `rejected`', async () => {
    handlerSpy('archive_thread', { ok: false });
    const rows = checkpoints();
    await run([model(callTool('archive_thread', ARCHIVE), answer('Done.'))], { extra: signedIn });
    expect(rows.finish().status).toBe('rejected');
  });

  test('a thrown write stores its class and code, not its words', async () => {
    const archive = handlerSpy('archive_thread');
    archive.mockRejectedValue(
      Object.assign(new Error('Could not reach sam@example.test'), { statusCode: 503 }),
    );
    const rows = checkpoints();
    await run([model(callTool('archive_thread', ARCHIVE), answer('Done.'))], { extra: signedIn });
    expect(rows.finish()).toMatchObject({ status: 'unknown', errorClass: 'provider', errorCode: 'http_503' });
    expect(JSON.stringify(rows.finish())).not.toContain('sam@example.test');
  });

  test('a stored success runs nothing, and the model reads the stored output', async () => {
    const archive = handlerSpy('archive_thread');
    checkpoints({ claimed: false, status: 'succeeded', output: { ok: true, stored: 'from-checkpoint' } });
    const mock = model(callTool('archive_thread', ARCHIVE), answer('Done.'));
    await run([mock], { extra: signedIn });
    expect(archive).not.toHaveBeenCalled();
    expect(promptOf(mock, 1)).toContain('from-checkpoint');
  });

  test('a stop before the call runs records that nothing was written', async () => {
    const archive = handlerSpy('archive_thread');
    const stop = new AbortController();
    const rows = checkpoints({ claimed: true }, () => stop.abort());
    await run([model(callTool('archive_thread', ARCHIVE), answer('Done.'))], {
      extra: { ...signedIn, signal: stop.signal },
    });
    expect(archive).not.toHaveBeenCalled();
    expect(rows.finish()?.status).toBe('rejected');
  });
});

describe('forwardAgentStream', () => {
  const collect = () => {
    const written: any[] = [];
    return { written, writer: { write: (chunk: any) => written.push(chunk) } as any };
  };

  test('an error that the SDK moves past stays out of the stream', async () => {
    const { written, writer } = collect();
    async function* chunks() {
      yield { type: 'start-step' };
      yield { type: 'text-start', id: 't' };
      yield { type: 'text-delta', id: 't', delta: 'First' };
      yield { type: 'error', errorText: 'Blip' };
      yield { type: 'finish-step' };
      yield { type: 'start-step' };
      yield { type: 'text-delta', id: 't', delta: 'Second' };
      yield { type: 'finish-step' };
    }
    const result = await forwardAgentStream(writer, chunks());
    expect(result.error).toBeUndefined();
    expect(written.map((chunk) => chunk.type)).not.toContain('error');
  });

  test('a thrown stream with held content writes one error, unless the caller holds it', async () => {
    async function* chunks() {
      yield { type: 'start-step' };
      yield { type: 'text-start', id: 't' };
      yield { type: 'text-delta', id: 't', delta: 'First' };
      throw new TypeError('terminated');
    }
    const plain = collect();
    const result = await forwardAgentStream(plain.writer, chunks());
    expect(result.thrown).toBe(true);
    expect(plain.written.at(-1)).toEqual({ type: 'error', errorText: 'terminated' });
    const held = collect();
    const outcome = await forwardAgentStream(held.writer, chunks(), undefined, undefined, undefined, {
      holdError: true,
    });
    expect(held.written.map((chunk) => chunk.type)).not.toContain('error');
    expect(outcome.heldError).toEqual({ type: 'error', errorText: 'terminated' });
    expect(outcome.closing).toEqual([{ type: 'text-end', id: 't' }, { type: 'finish-step' }]);
  });

  test('a thrown stream before content leaves no trace', async () => {
    const { written, writer } = collect();
    async function* chunks() {
      yield { type: 'start-step' };
      throw new TypeError('terminated');
    }
    const result = await forwardAgentStream(writer, chunks());
    expect(result).toMatchObject({ forwarded: false, thrown: true });
    expect(written).toEqual([]);
  });

  test('a stop during a thrown stream writes no error', async () => {
    const { written, writer } = collect();
    async function* chunks() {
      yield { type: 'text-delta', id: 't', delta: 'First' };
      throw new TypeError('terminated');
    }
    const result = await forwardAgentStream(writer, chunks(), undefined, undefined, undefined, {
      signal: AbortSignal.abort(),
    });
    expect(result.thrown).toBe(true);
    expect(written.map((chunk) => chunk.type)).toEqual(['text-delta']);
  });
});
