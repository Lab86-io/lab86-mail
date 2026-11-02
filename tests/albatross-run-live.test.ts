import { describe, expect, mock, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { stepCountIs, tool } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { z } from 'zod';
import {
  applyRunLogOps,
  closeRunLog,
  RUN_LIVE_TEXT_MAX,
  RUN_LIVE_WRITE_MS,
  runRowElapsed,
  showableRunText,
} from '../lib/albatross/run-live';
import { createRunLiveWriter, type RunLivePayload } from '../lib/albatross/run-live-writer';
import { RunModelStepStall, streamRunModel } from '../lib/albatross/run-model-stream';
import { toolStartLine } from '../lib/albatross/run-tool-lines';
import { RUNNER_REGISTRY_TOOLS } from '../lib/albatross/step-run-tools';

describe('applyRunLogOps', () => {
  test('text alone adds a line, and each row of a write has its own time, in order', () => {
    const rows = applyRunLogOps([], [{ text: ' One ' }, { text: 'Two' }], 100, 30);
    expect(rows).toEqual([
      { at: 100, text: 'One' },
      { at: 101, text: 'Two' },
    ]);
  });

  test('an open row takes its line in place and keeps its time', () => {
    const log = applyRunLogOps(
      [{ at: 1, text: 'First' }],
      [
        { key: 'a', text: 'Reads a page.', open: true },
        { key: 'b', text: 'Checks your calendar.', open: true },
      ],
      100,
      30,
    );
    expect(log.map((row) => row.key)).toEqual([undefined, 'a', 'b']);
    const closed = applyRunLogOps(log, [{ key: 'a', text: 'Read a page.' }], 200, 30);
    expect(closed).toEqual([
      { at: 1, text: 'First' },
      { at: 100, text: 'Read a page.' },
      { at: 101, text: 'Checks your calendar.', key: 'b' },
    ]);
  });

  test('a key alone removes the open row; a key with no row and no text does nothing', () => {
    const log = [{ at: 1, text: 'Reads a page.', key: 'a' }];
    expect(applyRunLogOps(log, [{ key: 'a' }], 100, 30)).toEqual([]);
    expect(applyRunLogOps(log, [{ key: 'other' }], 100, 30)).toEqual(log);
  });

  test('a line with a key and no open row is added as a plain line', () => {
    expect(applyRunLogOps([], [{ key: 'a', text: 'Second line.' }], 5, 30)).toEqual([
      { at: 5, text: 'Second line.' },
    ]);
  });

  test('the log keeps the newest rows, and a long line is cut', () => {
    const many = Array.from({ length: 5 }, (_, index) => ({ text: `Line ${index}` }));
    expect(applyRunLogOps([], many, 1, 3).map((row) => row.text)).toEqual(['Line 2', 'Line 3', 'Line 4']);
    expect(applyRunLogOps([], [{ text: 'x'.repeat(500) }], 1, 3)[0].text.length).toBeLessThanOrEqual(200);
  });

  test('closeRunLog drops only the open rows', () => {
    expect(
      closeRunLog([
        { at: 1, text: 'Done' },
        { at: 2, text: 'Reads', key: 'a' },
      ]),
    ).toEqual([{ at: 1, text: 'Done' }]);
  });
});

describe('showableRunText', () => {
  test('a word that is not finished waits', () => {
    expect(showableRunText('I found the inv')).toBe('I found the');
    expect(showableRunText('I found the invoice ')).toBe('I found the invoice');
    expect(showableRunText('one')).toBe('');
  });

  test('a few letters wait, so the row never shows one word alone', () => {
    expect(showableRunText('I ')).toBe('');
    expect(showableRunText('I will l')).toBe('');
    expect(showableRunText('I will look at')).toBe('I will look');
  });

  test('a secure reference waits until it closes, then redaction replaces it', () => {
    const clean = (text: string) => text.replace(/\{\{secure:[^}]*\}\}/g, '[saved value]');
    expect(showableRunText('Please use {{secure:abc', clean)).toBe('Please use');
    expect(showableRunText('Please use {{secure:abc}} now ', clean)).toBe('Please use [saved value] now');
  });

  test('the row holds a bounded part of a long text', () => {
    expect(showableRunText(`${'word '.repeat(2_000)}x`).length).toBeLessThanOrEqual(RUN_LIVE_TEXT_MAX);
  });
});

test('runRowElapsed stays quiet at first, then counts', () => {
  expect(runRowElapsed(-50)).toBeNull();
  expect(runRowElapsed(4_999)).toBeNull();
  expect(runRowElapsed(5_000)).toBe('5 s');
  expect(runRowElapsed(125_000)).toBe('2 min 5 s');
  expect(runRowElapsed(3_600_000)).toBeNull();
});

function writerHarness() {
  const writes: RunLivePayload[] = [];
  let clock = 1_000;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextId = 1;
  const writer = createRunLiveWriter({
    write: async (payload) => {
      writes.push(payload);
    },
    now: () => clock,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: clock + ms, fn });
      return id;
    },
    clearTimer: (id) => {
      timers.delete(id as number);
    },
  });
  const advance = async (ms: number) => {
    clock += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= clock) {
        timers.delete(id);
        timer.fn();
      }
    }
    await Promise.resolve();
    await Promise.resolve();
  };
  return { writer, writes, advance, timers };
}

describe('createRunLiveWriter', () => {
  test('the first line goes at once; later ones wait for the window and go together', async () => {
    const { writer, writes, advance } = writerHarness();
    writer.line('Started on the goal.');
    await advance(0);
    expect(writes).toEqual([{ lines: [{ text: 'Started on the goal.' }] }]);
    writer.line('Second.');
    writer.line('Third.');
    await advance(RUN_LIVE_WRITE_MS - 1);
    expect(writes).toHaveLength(1);
    await advance(1);
    expect(writes[1]).toEqual({ lines: [{ text: 'Second.' }, { text: 'Third.' }] });
  });

  test('a burst of text writes at most once in each window', async () => {
    const { writer, writes, advance } = writerHarness();
    for (let tick = 0; tick < 100; tick += 1) {
      writer.textDelta(`word${tick} `);
      await advance(50);
    }
    // 5 seconds of text at 2 seconds a write: the first, then two more.
    expect(writes.length).toBeLessThanOrEqual(4);
    expect(writes.at(-1)?.liveText).toContain('word');
  });

  test('a tool that ends before its row went out writes nothing extra', async () => {
    const { writer, writes, advance } = writerHarness();
    writer.line('Started.');
    await advance(0);
    writer.openTool('a', 'Reads a page.');
    writer.closeTool('a');
    writer.openTool('b', 'Reads a mail thread.');
    writer.line('Read a mail thread.', 'b');
    await writer.flush();
    expect(writes.slice(1)).toEqual([{ lines: [{ text: 'Read a mail thread.' }] }]);
  });

  test('a row that went out gets its line by key, or goes away by key', async () => {
    const { writer, writes, advance } = writerHarness();
    writer.openTool('a', 'Reads a page.');
    await advance(0);
    writer.line('Read a page.', 'a');
    writer.closeTool('a');
    writer.openTool('b', 'Checks your calendar.');
    await advance(RUN_LIVE_WRITE_MS);
    writer.closeTool('b');
    await writer.flush();
    expect(writes).toEqual([
      { lines: [{ key: 'a', text: 'Reads a page.', open: true }] },
      {
        lines: [
          { key: 'a', text: 'Read a page.' },
          { key: 'b', text: 'Checks your calendar.', open: true },
        ],
      },
      { lines: [{ key: 'b' }] },
    ]);
  });

  test('a second line of the same tool is a plain line', async () => {
    const { writer, writes, advance } = writerHarness();
    writer.openTool('a', 'Works on the page.');
    await advance(0);
    writer.line('First.', 'a');
    writer.line('Second.', 'a');
    await writer.flush();
    expect(writes[1].lines).toEqual([{ key: 'a', text: 'First.' }, { text: 'Second.' }]);
  });

  test('clearText writes once if text went out, and forgetText writes nothing', async () => {
    const { writer, writes, advance } = writerHarness();
    writer.textDelta('Some words ');
    await advance(0);
    expect(writes).toEqual([{ liveText: 'Some words' }]);
    writer.clearText();
    await advance(RUN_LIVE_WRITE_MS);
    expect(writes[1]).toEqual({ liveText: null });
    writer.textDelta('More words ');
    await advance(RUN_LIVE_WRITE_MS);
    writer.forgetText();
    await writer.flush();
    expect(writes).toHaveLength(3);
  });

  test('the same showable text does not write again, and clean runs on it', async () => {
    const writes: RunLivePayload[] = [];
    const writer = createRunLiveWriter({
      write: async (payload) => {
        writes.push(payload);
      },
      clean: (text) => text.replace('secret', '[saved value]'),
    });
    writer.textDelta('The secret ');
    await writer.flush();
    writer.textDelta('wo');
    await writer.flush();
    expect(writes).toEqual([{ liveText: 'The [saved value]' }]);
    writer.stop();
  });

  test('a failed write does not stop the next one, and writes keep their order', async () => {
    const order: string[] = [];
    let first = true;
    const writer = createRunLiveWriter({
      minIntervalMs: 0,
      write: async (payload) => {
        order.push(payload.lines?.[0]?.text ?? '');
        if (first) {
          first = false;
          throw new Error('offline');
        }
      },
    });
    writer.line('One.');
    writer.line('Two.');
    await writer.flush();
    expect(order).toEqual(['One.', 'Two.']);
    writer.stop();
  });

  test('stop ends the timer, so a finished run writes nothing later', async () => {
    const { writer, writes, advance, timers } = writerHarness();
    writer.line('One.');
    await advance(0);
    writer.line('Two.');
    expect(timers.size).toBe(1);
    writer.stop();
    expect(timers.size).toBe(0);
    await advance(RUN_LIVE_WRITE_MS * 2);
    expect(writes).toHaveLength(1);
  });
});

describe('toolStartLine', () => {
  // These work on the run itself or take no time: no row.
  const QUIET = new Set(['spreadsheet_capabilities']);

  test('each runner tool says what it does, in the present tense', () => {
    for (const name of RUNNER_REGISTRY_TOOLS) {
      if (QUIET.has(name)) continue;
      const line = toolStartLine(name, {});
      expect(line, name).toBeString();
      expect(line, name).toMatch(/^[A-Z][a-z]+s\b/);
      expect(line, name).toMatch(/\.$/);
      expect(line, name).not.toMatch(/\b\w+ing\b(?! )/);
      expect(line, name).not.toMatch(/\bAI\b/);
    }
  });

  test('the words of the call go in the line', () => {
    expect(toolStartLine('corpus_search', { query: 'July invoice' })).toBe(
      'Searches your mail for “July invoice”.',
    );
    expect(toolStartLine('browserbase_fetch', { url: 'https://www.irs.gov/forms' })).toBe('Reads irs.gov.');
    expect(toolStartLine('browser_open', { url: 'https://venue.example/book' })).toBe('Opens venue.example.');
    expect(toolStartLine('document_create', { title: 'Invoice 12' })).toBe('Writes “Invoice 12”.');
    expect(toolStartLine('web_file_save', { url: 'not a url' })).toBe('Saves a file from not a url.');
    expect(toolStartLine('corpus_search', { query: 'x'.repeat(300) })!.length).toBeLessThan(120);
  });

  test('the tools of the run itself stay quiet', () => {
    for (const name of ['step_handoff', 'step_note', 'checklist_set', 'goal_update'])
      expect(toolStartLine(name, {})).toBeNull();
  });
});

describe('streamRunModel', () => {
  const usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 4, text: 4, reasoning: 0 },
  };

  function textModel(parts: string[]) {
    return new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start' as const, warnings: [] },
            { type: 'text-start' as const, id: 't' },
            ...parts.map((delta) => ({ type: 'text-delta' as const, id: 't', delta })),
            { type: 'text-end' as const, id: 't' },
            {
              type: 'finish' as const,
              finishReason: { unified: 'stop' as const, raw: 'stop' },
              usage,
            },
          ],
        }),
      }),
    });
  }

  test('each text delta reaches the runner, and the result has the shape of generateText', async () => {
    const deltas: string[] = [];
    const onActivity = mock(() => undefined);
    const steps: any[] = [];
    const result = await streamRunModel({
      model: textModel(['I look ', 'for the ', 'invoice.']),
      messages: [{ role: 'user', content: 'Go' }],
      onTextDelta: (delta) => deltas.push(delta),
      onActivity,
      onStepFinish: (step: any) => {
        steps.push(step);
      },
    });
    expect(deltas).toEqual(['I look ', 'for the ', 'invoice.']);
    expect(onActivity.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(result.text).toBe('I look for the invoice.');
    expect(result.steps).toHaveLength(1);
    expect(result.totalUsage.inputTokens).toBe(10);
    expect(steps[0].text).toBe('I look for the invoice.');
  });

  test('a tool call runs in the same context in each step, and each step reports', async () => {
    const context = new AsyncLocalStorage<string>();
    const seen: Array<string | undefined> = [];
    let call = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        call += 1;
        const first = call === 1;
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start' as const, warnings: [] },
              ...(first
                ? [
                    {
                      type: 'tool-call' as const,
                      toolCallId: 'c1',
                      toolName: 'lookup',
                      input: '{}',
                    },
                  ]
                : [
                    { type: 'text-start' as const, id: 't' },
                    { type: 'text-delta' as const, id: 't', delta: 'Done.' },
                    { type: 'text-end' as const, id: 't' },
                  ]),
              {
                type: 'finish' as const,
                finishReason: first
                  ? { unified: 'tool-calls' as const, raw: 'tool_calls' }
                  : { unified: 'stop' as const, raw: 'stop' },
                usage,
              },
            ],
          }),
        };
      },
    });
    const steps: any[] = [];
    const result = await context.run('the run', () =>
      streamRunModel({
        model,
        messages: [{ role: 'user', content: 'Go' }],
        stopWhen: stepCountIs(4),
        tools: {
          lookup: tool({
            description: 'Look it up',
            inputSchema: z.object({}),
            execute: async () => {
              seen.push(context.getStore());
              return { ok: true };
            },
          }),
        },
        prepareStep: async () => {
          seen.push(context.getStore());
          return undefined;
        },
        onStepFinish: (step: any) => {
          steps.push(step);
        },
      }),
    );
    expect(seen).toEqual(['the run', 'the run', 'the run']);
    expect(steps).toHaveLength(2);
    expect(result.steps).toHaveLength(2);
    expect(result.text).toBe('Done.');
    expect(result.totalUsage.inputTokens).toBe(20);
  });

  test('a failed call throws, so the failover and the retry rules still see it', async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => {
        throw Object.assign(new Error('Provider returned error'), { statusCode: 503 });
      },
    });
    await expect(
      streamRunModel({ model, maxRetries: 0, messages: [{ role: 'user', content: 'Go' }] }),
    ).rejects.toThrow('Provider returned error');
  });

  /** A stream that sends the chunks with a wait before each one, and the finish at the end. */
  function slowStream(chunks: any[], waitMs: number, finish = true) {
    return new ReadableStream<any>({
      async start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        for (const chunk of chunks) {
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          try {
            controller.enqueue(chunk);
          } catch {
            return;
          }
        }
        if (!finish) return;
        controller.enqueue({
          type: 'finish',
          finishReason: chunks.some((chunk) => chunk.type === 'tool-call')
            ? { unified: 'tool-calls', raw: 'tool_calls' }
            : { unified: 'stop', raw: 'stop' },
          usage,
        });
        controller.close();
      },
    });
  }

  function writesArguments(count: number) {
    return [
      { type: 'tool-input-start', id: 'c1', toolName: 'lookup' },
      ...Array.from({ length: count }, () => ({ type: 'tool-input-delta', id: 'c1', delta: ' ' })),
    ];
  }

  const lookup = (execute: () => Promise<unknown>) => ({
    lookup: tool({ description: 'Look it up', inputSchema: z.object({}), execute }),
  });

  test('a step that writes past its limit ends with the stall, though chunks still arrive', async () => {
    const seen: string[] = [];
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: slowStream(writesArguments(1_000), 5) }),
    });
    const started = Date.now();
    await expect(
      streamRunModel({
        model,
        maxRetries: 0,
        messages: [{ role: 'user', content: 'Go' }],
        tools: lookup(async () => ({ ok: true })),
        stepTimeoutMs: 300,
        onActivity: () => seen.push('chunk'),
      }),
    ).rejects.toBeInstanceOf(RunModelStepStall);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(seen.length).toBeGreaterThan(1);
  });

  test('a long tool does not count against the step limit', async () => {
    let call = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        call += 1;
        return {
          stream:
            call === 1
              ? slowStream([{ type: 'tool-call', toolCallId: 'c1', toolName: 'lookup', input: '{}' }], 1)
              : slowStream(
                  [
                    { type: 'text-start', id: 't' },
                    { type: 'text-delta', id: 't', delta: 'Done.' },
                    { type: 'text-end', id: 't' },
                  ],
                  1,
                ),
        };
      },
    });
    const result = await streamRunModel({
      model,
      maxRetries: 0,
      messages: [{ role: 'user', content: 'Go' }],
      stopWhen: stepCountIs(4),
      tools: lookup(async () => {
        await new Promise((resolve) => setTimeout(resolve, 120));
        return { ok: true };
      }),
      stepTimeoutMs: 40,
    });
    expect(result.text).toBe('Done.');
    expect(result.steps).toHaveLength(2);
  });

  test('each step has its own limit', async () => {
    let call = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        call += 1;
        return {
          stream:
            call < 3
              ? slowStream(
                  [
                    ...writesArguments(6),
                    { type: 'tool-input-end', id: 'c1' },
                    { type: 'tool-call', toolCallId: `c${call}`, toolName: 'lookup', input: '{}' },
                  ],
                  40,
                )
              : slowStream(
                  [
                    { type: 'text-start', id: 't' },
                    { type: 'text-delta', id: 't', delta: 'Done.' },
                    { type: 'text-end', id: 't' },
                  ],
                  1,
                ),
        };
      },
    });
    const result = await streamRunModel({
      model,
      maxRetries: 0,
      messages: [{ role: 'user', content: 'Go' }],
      stopWhen: stepCountIs(5),
      tools: lookup(async () => ({ ok: true })),
      stepTimeoutMs: 600,
    });
    expect(result.text).toBe('Done.');
    expect(result.steps).toHaveLength(3);
  });

  test('the step clock also starts for a later step, and the caller gets prepareStep and each finish', async () => {
    let call = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        call += 1;
        return call === 1
          ? {
              stream: slowStream(
                [{ type: 'tool-call', toolCallId: 'c1', toolName: 'lookup', input: '{}' }],
                1,
              ),
            }
          : { stream: slowStream(writesArguments(200), 5) };
      },
    });
    const finished: number[] = [];
    let prepared = 0;
    await expect(
      streamRunModel({
        model,
        maxRetries: 0,
        messages: [{ role: 'user', content: 'Go' }],
        stopWhen: stepCountIs(4),
        tools: lookup(async () => ({ ok: true })),
        stepTimeoutMs: 40,
        prepareStep: async () => {
          prepared += 1;
          return undefined;
        },
        onStepFinish: () => {
          finished.push(call);
        },
      }),
    ).rejects.toBeInstanceOf(RunModelStepStall);
    expect(prepared).toBe(2);
    expect(finished).toEqual([1]);
  });

  test('with no limit, a slow step keeps its time', async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: slowStream(
          [
            { type: 'text-start', id: 't' },
            { type: 'text-delta', id: 't', delta: 'Done.' },
            { type: 'text-end', id: 't' },
          ],
          20,
        ),
      }),
    });
    const result = await streamRunModel({
      model,
      maxRetries: 0,
      messages: [{ role: 'user', content: 'Go' }],
    });
    expect(result.text).toBe('Done.');
  });

  test('a stop throws its reason', async () => {
    class Stopped extends Error {}
    const stop = new AbortController();
    const model = new MockLanguageModelV3({
      doStream: async ({ abortSignal }) => {
        stop.abort(new Stopped('stopped'));
        abortSignal?.throwIfAborted();
        throw new Error('unreachable');
      },
    });
    await expect(
      streamRunModel({
        model,
        maxRetries: 0,
        messages: [{ role: 'user', content: 'Go' }],
        abortSignal: stop.signal,
      }),
    ).rejects.toBeInstanceOf(Stopped);
  });
});
