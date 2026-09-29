import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { APICallError } from 'ai';
import { generateTextForCurrentUser } from '../lib/ai/gateway';

// The gateway logs a failed model call before it moves to a fallback model.
// The log line holds the describeModelError summary: never the prompt or the
// provider answer (CASA S8).

const PROMPT = 'Dear Jakob, the merger closes Friday. Wire code 4471.';

const hosted = {
  userId: 'user_log',
  source: 'lab86',
  provider: 'openrouter',
  modelName: 'anthropic/claude-opus-5.5',
  model: 'primary',
} as any;
const fallback = { ...hosted, modelName: 'openai/gpt-5.5', model: 'fallback' };

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()?.();
});

function captureWarnings() {
  const spy = spyOn(console, 'warn').mockImplementation(() => undefined);
  restores.push(() => spy.mockRestore());
  return spy;
}

async function runWithPrimaryError(error: unknown) {
  const models: string[] = [];
  const result = await generateTextForCurrentUser(
    { feature: 'agent', prompt: PROMPT },
    {
      resolveAiRuntime: async () => hosted,
      fallbackRuntimes: () => [fallback],
      recordUsage: (async () => undefined) as any,
      generateText: (async (request: any) => {
        models.push(request.model);
        if (request.model === 'fallback')
          return { text: 'ok', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
        throw error;
      }) as any,
    },
  );
  return { result, models };
}

describe('gateway fallback log', () => {
  test('a provider 5xx moves to the fallback and logs only the summary', async () => {
    const warnings = captureWarnings();
    const error = new APICallError({
      message: 'Service Unavailable',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      requestBodyValues: { messages: [{ role: 'user', content: PROMPT }] },
      statusCode: 503,
      responseBody: `{"error":"overloaded","echo":${JSON.stringify(PROMPT)}}`,
    });

    const { result, models } = await runWithPrimaryError(error);

    expect(result.text).toBe('ok');
    expect(models).toEqual(['primary', 'fallback']);
    const line = warnings.mock.calls.find(
      (call) => call[0] === '[ai-gateway] agent model failed; trying fallback',
    );
    expect(line?.[1]).toMatchObject({
      model: 'anthropic/claude-opus-5.5',
      fallback: 'openai/gpt-5.5',
      error: { name: 'AI_APICallError', statusCode: 503, message: 'Service Unavailable' },
    });
    const printed = Bun.inspect(warnings.mock.calls);
    expect(printed).not.toContain('merger');
    expect(printed).not.toContain('overloaded');
  });

  test('a provider error named only in the answer body also moves to the fallback', async () => {
    const warnings = captureWarnings();
    const error = Object.assign(new Error('Upstream failed'), {
      responseBody: `Provider returned error for ${PROMPT}`,
    });

    const { result, models } = await runWithPrimaryError(error);

    expect(result.text).toBe('ok');
    expect(models).toEqual(['primary', 'fallback']);
    const printed = Bun.inspect(warnings.mock.calls);
    expect(printed).toContain('Upstream failed');
    expect(printed).not.toContain('merger');
  });
});
