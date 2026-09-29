import { afterEach, describe, expect, test } from 'bun:test';
import { createOpenAI } from '@ai-sdk/openai';
import { generateObject, generateText } from 'ai';
import { z } from 'zod';
import {
  captureGenerationIdFetch,
  GENERATION_LOOKUP_DELAYS_MS,
  lookupGenerationCosts,
  newGenerationCapture,
  readGenerationCost,
  recordFailedModelCall,
  runWithGenerationCapture,
  usageFromError,
} from '../lib/ai/generation-cost';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function completion(id: string, content: string, status = 200) {
  return new Response(
    JSON.stringify({
      id,
      object: 'chat.completion',
      created: 1,
      model: 'anthropic/claude-opus-5.5',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 516, completion_tokens: 158, total_tokens: 674 },
    }),
    { status, headers: { 'content-type': 'application/json', 'x-generation-id': id } },
  );
}

function generation(data: Record<string, unknown> | null, status = 200) {
  return new Response(data ? JSON.stringify({ data }) : 'not json', { status });
}

const hosted = { provider: 'openrouter', source: 'lab86', modelName: 'anthropic/claude-opus-5.5' };

describe('generation ids', () => {
  test('a capture keeps the ids of the responses inside it only', async () => {
    let served = 0;
    const fetcher = captureGenerationIdFetch(async () => {
      served += 1;
      return new Response('{}', { headers: served === 2 ? {} : { 'x-generation-id': `gen-${served}` } });
    });
    const capture = newGenerationCapture();
    await runWithGenerationCapture(capture, async () => {
      await fetcher('https://openrouter.ai/api/v1/chat/completions');
      await fetcher('https://openrouter.ai/api/v1/chat/completions');
    });
    await fetcher('https://openrouter.ai/api/v1/chat/completions');
    expect(capture.ids).toEqual(['gen-1']);
    // With no base, the global fetch of the moment serves the request.
    globalThis.fetch = (async () =>
      new Response('{}', { headers: { 'x-generation-id': 'gen-global' } })) as unknown as typeof fetch;
    const late = newGenerationCapture();
    await runWithGenerationCapture(late, () => captureGenerationIdFetch()('https://openrouter.ai'));
    expect(late.ids).toEqual(['gen-global']);
  });

  test('the AI SDK request of a failed schema call leaves its id and its usage', async () => {
    const provider = createOpenAI({
      apiKey: 'test',
      baseURL: 'https://openrouter.ai/api/v1',
      // Ten queries for a schema limit of four, like the real Opus 5.5 answer.
      fetch: captureGenerationIdFetch(async () =>
        completion('gen-opus', JSON.stringify({ queries: Array.from({ length: 10 }, (_, i) => `q${i}`) })),
      ),
    });
    const capture = newGenerationCapture();
    const failure = await runWithGenerationCapture(capture, () =>
      generateObject({
        model: provider.chat('anthropic/claude-opus-5.5'),
        schema: z.object({ queries: z.array(z.string()).max(4) }),
        prompt: 'Plan the research.',
      }),
    ).catch((error) => error);
    expect(failure.message).toContain('did not match schema');
    expect(capture.ids).toEqual(['gen-opus']);
    expect(usageFromError(failure)).toMatchObject({ inputTokens: 516, outputTokens: 158 });
    // A text call through the same client also notes its id.
    const text = newGenerationCapture();
    await runWithGenerationCapture(text, () =>
      generateText({ model: provider.chat('anthropic/claude-opus-5.5'), prompt: 'Hi' }),
    );
    expect(text.ids).toEqual(['gen-opus']);
  });

  test('usage is read through wrapped errors, and an error with no tokens has none', () => {
    const usage = { inputTokens: 5, outputTokens: 0 };
    expect(usageFromError({ lastError: { cause: { usage } } })).toBe(usage);
    expect(usageFromError({ usage: { inputTokens: 0, outputTokens: 0 } })).toBeUndefined();
    expect(usageFromError(new Error('plain'))).toBeUndefined();
    expect(usageFromError(null)).toBeUndefined();
    expect(usageFromError('text')).toBeUndefined();
  });
});

describe('the generation cost lookup', () => {
  test('reads the real cost and the native token counts', async () => {
    const asked: Array<{ url: string; auth: string | null }> = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      asked.push({ url, auth: new Headers(init?.headers).get('authorization') });
      return generation({
        total_cost: 0.005224,
        native_tokens_prompt: 516,
        native_tokens_completion: 158,
        tokens_prompt: 211,
      });
    }) as unknown as typeof fetch;
    expect(await readGenerationCost('gen-1/x', { apiKey: 'key', fetch: fetcher })).toEqual({
      costUsd: 0.005224,
      inputTokens: 516,
      outputTokens: 158,
    });
    expect(asked[0]).toEqual({
      url: 'https://openrouter.ai/api/v1/generation?id=gen-1%2Fx',
      auth: 'Bearer key',
    });
    const read = (response: Response) =>
      readGenerationCost('gen', { apiKey: 'k', fetch: (async () => response) as unknown as typeof fetch });
    expect(await read(generation(null, 404))).toBeNull();
    expect(await read(generation(null))).toBeNull();
    expect(await read(generation({ total_cost: -1 }))).toBeNull();
    expect(await read(generation({ total_cost: 0.5, tokens_prompt: 7 }))).toEqual({
      costUsd: 0.5,
      inputTokens: 7,
      outputTokens: 0,
    });
  });

  test('a lookup request that hangs stops at its time limit, and the round goes on', async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    const hang = (async (url: string, init?: RequestInit) => {
      signals.push(init?.signal);
      if (url.endsWith('gen-ok')) return generation({ total_cost: 0.1 });
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    }) as unknown as typeof fetch;
    const error = (await readGenerationCost('gen-hang', { apiKey: 'k', fetch: hang, timeoutMs: 5 }).catch(
      (e: unknown) => e,
    )) as Error;
    expect(error.name).toBe('TimeoutError');
    expect(
      await lookupGenerationCosts(['gen-hang', 'gen-ok'], {
        apiKey: 'k',
        fetch: hang,
        sleep: async () => {},
        delaysMs: [0],
        timeoutMs: 5,
      }),
    ).toEqual({ costUsd: 0.1, inputTokens: 0, outputTokens: 0 });
    // Without an option, each request still has a limit.
    await readGenerationCost('gen-ok', { apiKey: 'k', fetch: hang });
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  });

  test('waits, reads again the ids with no record yet, and sums them', async () => {
    const waits: number[] = [];
    let round = 0;
    const fetcher = (async (url: string) => {
      if (url.endsWith('gen-a')) return generation({ total_cost: 0.25, native_tokens_prompt: 100 });
      if (url.endsWith('gen-err')) throw new Error('network');
      // gen-b has a record only from the second round.
      return round >= 2
        ? generation({ total_cost: 0.5, native_tokens_completion: 20 })
        : generation(null, 404);
    }) as unknown as typeof fetch;
    const sleep = async (ms: number) => {
      waits.push(ms);
      round += 1;
    };
    expect(
      await lookupGenerationCosts(['gen-a', 'gen-b', 'gen-err'], { apiKey: 'k', fetch: fetcher, sleep }),
    ).toEqual({ costUsd: 0.75, inputTokens: 100, outputTokens: 20 });
    expect(waits).toEqual(GENERATION_LOOKUP_DELAYS_MS);
    // All found in the first round: no more waits.
    waits.length = 0;
    round = 5;
    await lookupGenerationCosts(['gen-a'], { apiKey: 'k', fetch: fetcher, sleep, delaysMs: [1, 2] });
    expect(waits).toEqual([1]);
    expect(await lookupGenerationCosts(['gen-err'], { apiKey: 'k', fetch: fetcher, sleep })).toBeNull();
    // The default wait is a real timer.
    expect(
      await lookupGenerationCosts(['gen-a'], { apiKey: 'k', fetch: fetcher, delaysMs: [0] }),
    ).toMatchObject({
      costUsd: 0.25,
    });
  });
});

describe('recording a failed call', () => {
  function recorder() {
    const rows: any[][] = [];
    return { rows, record: async (...row: any[]) => void rows.push(row) };
  }

  test('with no generation id, the row is written at once with the usage the error kept', async () => {
    const { rows, record } = recorder();
    const error = Object.assign(new Error('No object generated: response did not match schema.'), {
      usage: { inputTokens: 516, outputTokens: 158 },
    });
    await recordFailedModelCall({ runtime: hosted, feature: 'f', error, record, apiKey: 'k' });
    expect(rows[0].slice(1)).toEqual([
      'f',
      { inputTokens: 516, outputTokens: 158 },
      false,
      'No object generated: response did not match schema.',
    ]);
    // A direct key or an own key pays its own bill: no lookup.
    for (const runtime of [
      { ...hosted, provider: 'anthropic' },
      { ...hosted, source: 'byok' },
    ]) {
      await recordFailedModelCall({
        runtime,
        feature: 'f',
        error: new Error('x'),
        generationIds: ['gen-1'],
        record,
        apiKey: 'k',
        lookup: async () => {
          throw new Error('no lookup');
        },
      });
    }
    expect(rows).toHaveLength(3);
    // No key for the lookup: at once too.
    const saved = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = '';
    try {
      await recordFailedModelCall({
        runtime: hosted,
        feature: 'f',
        error: 'text',
        generationIds: ['g'],
        record,
      });
    } finally {
      // An assigned undefined becomes the string "undefined", a key for later files.
      if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = saved;
    }
    expect(rows[3].slice(2)).toEqual([undefined, false, undefined]);
  });

  test('a hosted OpenRouter call records the real cost after the caller continues', async () => {
    const { rows, record } = recorder();
    const tasks: Array<Promise<void>> = [];
    const looked: string[][] = [];
    await recordFailedModelCall({
      runtime: hosted,
      feature: 'brief_preparation_research',
      error: Object.assign(new Error('stopped'), { response: { id: 'gen-response' } }),
      generationIds: ['gen-header', 'gen-response'],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      message: 'The turn was stopped before it finished.',
      record,
      apiKey: 'k',
      lookup: async (ids, options) => {
        looked.push([...ids, options.apiKey]);
        return { costUsd: 0.42, inputTokens: 135_000, outputTokens: 900 };
      },
      schedule: (task) => void tasks.push(task()),
    });
    // The caller continued before the row was written.
    expect(rows).toHaveLength(0);
    await Promise.all(tasks);
    expect(looked).toEqual([['gen-header', 'gen-response', 'k']]);
    expect(rows[0].slice(1)).toEqual([
      'brief_preparation_research',
      { inputTokens: 135_000, outputTokens: 900, totalTokens: undefined, costUsd: 0.42 },
      false,
      'The turn was stopped before it finished.',
    ]);
  });

  test('a lookup with no result keeps the usage; the default schedule runs detached', async () => {
    const { rows, record } = recorder();
    const tasks: Array<Promise<void>> = [];
    await recordFailedModelCall({
      runtime: hosted,
      feature: 'f',
      error: Object.assign(new Error('x'), { usage: { inputTokens: 3, outputTokens: 0 } }),
      generationIds: ['gen-1'],
      record,
      apiKey: 'k',
      lookup: async () => null,
      schedule: (task) => void tasks.push(task()),
    });
    await Promise.all(tasks);
    expect(rows[0][2]).toEqual({ inputTokens: 3, outputTokens: 0 });
    let resolve!: () => void;
    const done = new Promise<void>((yes) => {
      resolve = yes;
    });
    await recordFailedModelCall({
      runtime: hosted,
      feature: 'f',
      error: new Error('x'),
      generationIds: ['gen-2'],
      record: async (...row: any[]) => {
        rows.push(row);
        resolve();
      },
      apiKey: 'k',
      lookup: async () => ({ costUsd: 0.01, inputTokens: 0, outputTokens: 0 }),
    });
    await done;
    expect(rows[1][2]).toMatchObject({ costUsd: 0.01, inputTokens: 0, outputTokens: 0 });
  });
});
