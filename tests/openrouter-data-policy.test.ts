import { afterEach, describe, expect, test } from 'bun:test';
import { generateText, streamText } from 'ai';
import {
  createOpenRouterProvider,
  OPENROUTER_DATA_POLICY,
  openRouterFetch,
  withOpenRouterDataPolicy,
} from '../lib/ai/openrouter-policy';

// Google Limited Use: every OpenRouter request must ask for endpoints that
// do not train on the data. These tests read the request bodies that leave
// the process.

type Captured = { url: string; body: any; headers: Headers };

function chatReply() {
  return Response.json({
    id: 'gen-1',
    object: 'chat.completion',
    created: 0,
    model: 'openai/gpt-5.5',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  });
}

function streamReply() {
  const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  const base = { id: 'gen-1', object: 'chat.completion.chunk', created: 0, model: 'openai/gpt-5.5' };
  return new Response(
    chunk({
      ...base,
      choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }],
    }) +
      chunk({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }) +
      'data: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

function capture(reply: () => Response = chatReply) {
  const requests: Captured[] = [];
  const fetcher = (async (input: any, init?: RequestInit) => {
    requests.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: new Headers(init?.headers),
    });
    return reply();
  }) as unknown as typeof fetch;
  return { requests, fetcher };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

if (process.env.OPENROUTER_POLICY_PLATFORM_CHILD === '1') {
  // Runs in a child process with OPENROUTER_API_KEY set, so lib/ai/client
  // builds the platform provider from a clean module cache.
  test('the platform OpenRouter client sends the data policy', async () => {
    const { requests, fetcher } = capture();
    globalThis.fetch = fetcher;
    const { openrouter } = await import('../lib/ai/client');
    expect(openrouter).not.toBeNull();
    await generateText({ model: openrouter!.chat('anthropic/claude-sonnet-4.6'), prompt: 'Say ok.' });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(requests[0].headers.get('authorization')).toBe('Bearer sk-or-platform-test');
    expect(requests[0].body).toMatchObject({
      model: 'anthropic/claude-sonnet-4.6',
      provider: { data_collection: 'deny' },
    });
  });
} else {
  describe('withOpenRouterDataPolicy', () => {
    test('adds the policy, keeps other provider preferences, and replaces allow', () => {
      expect(OPENROUTER_DATA_POLICY).toEqual({ data_collection: 'deny' });
      expect(withOpenRouterDataPolicy({ model: 'm' })).toEqual({
        model: 'm',
        provider: { data_collection: 'deny' },
      });
      expect(
        withOpenRouterDataPolicy({ model: 'm', provider: { order: ['azure'], data_collection: 'allow' } }),
      ).toEqual({ model: 'm', provider: { order: ['azure'], data_collection: 'deny' } });
      expect(withOpenRouterDataPolicy({ model: 'm', provider: 'bad' } as Record<string, unknown>)).toEqual({
        model: 'm',
        provider: { data_collection: 'deny' },
      });
    });
  });

  describe('openRouterFetch', () => {
    test('adds the policy to a JSON body and keeps the other request options', async () => {
      const { requests, fetcher } = capture();
      await openRouterFetch(fetcher)('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer k' },
        body: JSON.stringify({ model: 'm', messages: [] }),
      });
      expect(requests[0].body).toEqual({ model: 'm', messages: [], provider: { data_collection: 'deny' } });
      expect(requests[0].headers.get('authorization')).toBe('Bearer k');
    });

    test('sends a request with no body as it is', async () => {
      const { requests, fetcher } = capture();
      await openRouterFetch(fetcher)('https://openrouter.ai/api/v1/models');
      expect(requests).toEqual([
        { url: 'https://openrouter.ai/api/v1/models', body: undefined, headers: new Headers() },
      ]);
    });

    test('stops a request whose body cannot carry the policy', async () => {
      const { requests, fetcher } = capture();
      const send = openRouterFetch(fetcher);
      for (const body of ['not json', JSON.stringify(['a']), new FormData()])
        await expect(send('https://openrouter.ai/api/v1/x', { method: 'POST', body })).rejects.toThrow(
          'data policy',
        );
      expect(requests).toHaveLength(0);
    });

    test('with no base fetch, it reads globalThis.fetch at request time', async () => {
      const send = openRouterFetch();
      const { requests, fetcher } = capture();
      globalThis.fetch = fetcher;
      await send('https://openrouter.ai/api/v1/embeddings', { method: 'POST', body: '{"input":"a b c"}' });
      expect(requests[0].body).toEqual({ input: 'a b c', provider: { data_collection: 'deny' } });
    });
  });

  describe('the AI SDK provider', () => {
    test('a generated reply sends the policy to the chat endpoint', async () => {
      const { requests, fetcher } = capture();
      const provider = createOpenRouterProvider('sk-or-test', { fetch: fetcher });
      const result = await generateText({ model: provider.chat('openai/gpt-5.5'), prompt: 'Say ok.' });
      expect(result.text).toBe('ok');
      expect(requests[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
      expect(requests[0].headers.get('x-title')).toBe('lab86-mail');
      expect(requests[0].body).toMatchObject({
        model: 'openai/gpt-5.5',
        provider: { data_collection: 'deny' },
      });
    });

    test('a streamed reply sends the policy too', async () => {
      const { requests, fetcher } = capture(streamReply);
      const provider = createOpenRouterProvider('sk-or-test', { fetch: fetcher });
      const result = streamText({ model: provider.chat('openai/gpt-5.5'), prompt: 'Say ok.' });
      expect(await result.text).toBe('ok');
      expect(requests[0].body).toMatchObject({ stream: true, provider: { data_collection: 'deny' } });
    });

    test("a user's own OpenRouter key gets the same policy", async () => {
      const { modelFromKey } = await import('../lib/ai/gateway');
      const { requests, fetcher } = capture();
      globalThis.fetch = fetcher;
      await generateText({
        model: modelFromKey('openrouter', 'sk-or-user', 'openai/gpt-5.5'),
        prompt: 'Say ok.',
      });
      expect(requests[0].headers.get('authorization')).toBe('Bearer sk-or-user');
      expect(requests[0].body).toMatchObject({
        model: 'openai/gpt-5.5',
        provider: { data_collection: 'deny' },
      });
    });
  });

  test('the platform OpenRouter client sends the data policy (child process)', async () => {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENROUTER_POLICY_PLATFORM_CHILD: '1',
        OPENROUTER_API_KEY: 'sk-or-platform-test',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
    expect(stderr).toContain('1 pass');
  }, 15000);
  describe('the platform provider description', () => {
    test('it names the first configured provider and its default models', async () => {
      const { describeProvider, hasAi, pickFastModel, pickPrimaryModel } = await import('../lib/ai/client');
      const none = { openrouter: null, openai: null, anthropic: null };
      expect(describeProvider({ ...none, openrouter: {} })).toEqual({
        provider: 'openrouter',
        primary: pickPrimaryModel({ ...none, openrouter: {} }),
        fast: pickFastModel({ ...none, openrouter: {} }),
      });
      expect(describeProvider({ ...none, openai: {} }).provider).toBe('openai');
      expect(describeProvider({ ...none, anthropic: {} })).toEqual({
        provider: 'anthropic',
        primary: 'claude-sonnet-4-6',
        fast: 'claude-haiku-4-5-20251001',
      });
      expect(describeProvider(none)).toEqual({ provider: 'none', primary: '', fast: '' });
      expect(pickPrimaryModel({ ...none, openai: {} }, {})).toBe('gpt-5.5');
      expect(pickFastModel({ ...none, openai: {} }, {})).toBe('gpt-5-nano');
      expect(
        pickPrimaryModel({ ...none, openrouter: {} }, { LAB86_MAIL_OPENAI_MODEL: 'z-ai/glm-5.3-flash' }),
      ).toBe('z-ai/glm-5.3-flash');
      expect(pickFastModel({ ...none, openrouter: {} }, {})).toBe('openai/gpt-5-nano');
      expect(pickPrimaryModel(none, {})).toBe('');
      expect(pickFastModel(none, {})).toBe('');
      expect(typeof hasAi()).toBe('boolean');
    });
  });
}
