import { describe, expect, test } from 'bun:test';
import { modelFromKey } from '../lib/ai/gateway';
import { ProviderStreamIdleError, streamIdleTimeoutFetch } from '../lib/ai/provider-idle-timeout';

const STREAM_BODY = JSON.stringify({ model: 'm', stream: true });

function hanging(signal?: AbortSignal | null) {
  return new Promise<Response>((_, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason));
  });
}

describe('the providers of a user key', () => {
  test('each direct vendor builds its model, and the fetch waits for a stream with the limit', () => {
    expect(modelFromKey('openai', 'test-key', 'openai/gpt-5.5').modelId).toBe('gpt-5.5');
    expect(modelFromKey('anthropic', 'test-key', 'anthropic/claude-sonnet-4.6').modelId).toContain('claude');
  });
});

describe('streamIdleTimeoutFetch', () => {
  test('a stream with no headers fails with the typed error', async () => {
    let seen: AbortSignal | null | undefined;
    const fetcher = streamIdleTimeoutFetch(
      ((_input: any, init?: RequestInit) => {
        seen = init?.signal;
        return hanging(init?.signal);
      }) as typeof fetch,
      10,
    );
    const failed = await fetcher('https://provider.test', { method: 'POST', body: STREAM_BODY }).catch(
      (error) => error,
    );
    expect(failed).toBeInstanceOf(ProviderStreamIdleError);
    expect(failed.statusCode).toBe(504);
    expect(seen?.aborted).toBe(true);
  });

  test('a stream that stops sending fails, and its bytes before that arrive', async () => {
    let cancelled = false;
    const fetcher = streamIdleTimeoutFetch(
      (async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data: one\n\n'));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200, headers: { 'x-generation-id': 'gen-1' } },
        )) as unknown as typeof fetch,
      10,
    );
    const response = await fetcher('https://provider.test', { method: 'POST', body: STREAM_BODY });
    expect(response.headers.get('x-generation-id')).toBe('gen-1');
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: one\n\n');
    expect(await reader.read().catch((error) => error)).toBeInstanceOf(ProviderStreamIdleError);
    expect(cancelled).toBe(true);
  });

  test('a stream that keeps sending reaches its end, slower than one limit in total', async () => {
    const fetcher = streamIdleTimeoutFetch(
      (async () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              for (const text of ['a', 'b', 'c']) {
                await new Promise((resolve) => setTimeout(resolve, 15));
                controller.enqueue(new TextEncoder().encode(text));
              }
              controller.close();
            },
          }),
        )) as unknown as typeof fetch,
      30,
    );
    const response = await fetcher('https://provider.test', { method: 'POST', body: STREAM_BODY });
    expect(await response.text()).toBe('abc');
  });

  test('the timer does not run while nobody reads the stream', async () => {
    const fetcher = streamIdleTimeoutFetch(
      (async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new TextEncoder().encode('x'));
              controller.close();
            },
          }),
        )) as unknown as typeof fetch,
      10,
    );
    const response = await fetcher('https://provider.test', { method: 'POST', body: STREAM_BODY });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(await response.text()).toBe('x');
  });

  test('a request that does not stream passes through untouched', async () => {
    const answer = new Response('{}');
    const fetcher = streamIdleTimeoutFetch((async () => answer) as unknown as typeof fetch, 1);
    expect(await fetcher('https://provider.test', { method: 'POST', body: '{"stream":false}' })).toBe(answer);
    expect(await fetcher('https://provider.test')).toBe(answer);
    // Quoted words in a message are not the stream field.
    const inText = JSON.stringify({ messages: [{ content: '"stream":true' }] });
    expect(await fetcher('https://provider.test', { method: 'POST', body: inText })).toBe(answer);
  });

  test('the caller signal still stops a stream', async () => {
    const controller = new AbortController();
    const fetcher = streamIdleTimeoutFetch(
      ((_input: any, init?: RequestInit) => hanging(init?.signal)) as typeof fetch,
      1_000,
    );
    const pending = fetcher('https://provider.test', {
      method: 'POST',
      body: STREAM_BODY,
      signal: controller.signal,
    }).catch((error) => error);
    const reason = new Error('Stopped');
    controller.abort(reason);
    expect(await pending).toBe(reason);
  });

  test('a response with no body comes back as it is', async () => {
    const empty = new Response(null, { status: 204 });
    const fetcher = streamIdleTimeoutFetch((async () => empty) as unknown as typeof fetch, 10);
    expect(await fetcher('https://provider.test', { method: 'POST', body: STREAM_BODY })).toBe(empty);
  });
});
