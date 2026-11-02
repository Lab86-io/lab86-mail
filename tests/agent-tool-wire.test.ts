import { afterEach, describe, expect, test } from 'bun:test';
import { generateText } from 'ai';
import { modelFromKey } from '../lib/ai/gateway';
import { liftToolsForAgent } from '../lib/ai/loop';
import { buildRunnerTools, type RunnerToolHost } from '../lib/albatross/step-run-tools';

// The tests read the request bodies that leave the process. No request goes out:
// the fake fetch keeps the body and refuses the call.

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function requestBody(provider: 'openai' | 'openrouter' | 'anthropic', modelName: string) {
  const bodies: any[] = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ error: { message: 'refused by the test' } }, { status: 400 });
  }) as unknown as typeof fetch;
  const { document_create, save_draft, ask_user } = liftToolsForAgent(undefined, 'UTC', undefined, {
    clientPlatform: 'ios',
  });
  const result = await generateText({
    model: modelFromKey(provider, 'test-key', modelName),
    prompt: 'Go',
    maxRetries: 0,
    tools: { document_create, save_draft, ask_user },
  }).catch(() => null);
  expect(result).toBeNull();
  expect(bodies).toHaveLength(1);
  return bodies[0];
}

function runnerHost(goal: boolean): RunnerToolHost {
  return {
    goal,
    log: async () => undefined,
    artifact: async () => undefined,
    enqueueApproval: async () => 'approval-1',
    finish: async () => undefined,
  } as unknown as RunnerToolHost;
}

describe('the wire of the agent tools', () => {
  test('each lifted tool, with the tools that wait for the user, is not strict', () => {
    const lifted = liftToolsForAgent(undefined, 'UTC', undefined, { clientPlatform: 'web' });
    expect(Object.keys(lifted).length).toBeGreaterThan(50);
    for (const [name, spec] of Object.entries(lifted)) expect([name, spec.strict]).toEqual([name, false]);
  });

  test('a run keeps it on each tool, for a goal run and for a step run', () => {
    const lifted = liftToolsForAgent(undefined, 'UTC', undefined, { clientPlatform: 'ios' });
    for (const goal of [true, false]) {
      const tools = buildRunnerTools(lifted, runnerHost(goal));
      expect(tools.step_handoff).toBeDefined();
      expect(tools.document_create).toBeDefined();
      for (const [name, spec] of Object.entries(tools)) expect([name, spec.strict]).toEqual([name, false]);
    }
  });

  test('the Responses wire of a direct OpenAI key says strict false', async () => {
    const body = await requestBody('openai', 'gpt-5.5');
    expect(body.tools.map((entry: any) => [entry.name, entry.strict])).toEqual([
      ['document_create', false],
      ['save_draft', false],
      ['ask_user', false],
    ]);
  });

  test('the OpenRouter wire says strict false and keeps the data policy', async () => {
    const body = await requestBody('openrouter', 'openai/gpt-5.5');
    expect(body.provider).toEqual({ data_collection: 'deny' });
    expect(body.tools.map((entry: any) => [entry.function.name, entry.function.strict])).toEqual([
      ['document_create', false],
      ['save_draft', false],
      ['ask_user', false],
    ]);
  });

  test('an Anthropic fallback with strict tools gets the field, and the schema stays', async () => {
    const body = await requestBody('anthropic', 'anthropic/claude-sonnet-4.6');
    expect(body.tools.map((entry: any) => [entry.name, entry.strict])).toEqual([
      ['document_create', false],
      ['save_draft', false],
      ['ask_user', false],
    ]);
    expect(body.tools[0].input_schema.properties.kind).toBeDefined();
  });

  test('an Anthropic model with no strict tools does not get the field', async () => {
    const body = await requestBody('anthropic', 'claude-3-haiku-20240307');
    expect(body.tools.map((entry: any) => entry.strict)).toEqual([undefined, undefined, undefined]);
  });
});
