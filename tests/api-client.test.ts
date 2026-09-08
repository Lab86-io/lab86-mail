import { afterEach, expect, test } from 'bun:test';
import { callTool, health, listTools, readSearchSource } from '../lib/api-client';

const originalFetch = globalThis.fetch;
test('search sources reject malformed, empty and failed responses with safe recovery text', async () => {
  const signal = new AbortController().signal;
  for (const [body, status] of [
    ['<html>failure</html>', 502],
    ['', 200],
    ['null', 200],
    ['{"ok":false}', 200],
  ] as const) {
    response(body, status);
    await expect(readSearchSource('/source', signal)).rejects.toThrow('Could not search this source.');
  }
  response('{"ok":false,"error":"Please reconnect"}', 409);
  await expect(readSearchSource('/source', signal)).rejects.toThrow('Please reconnect');
});

test('search sources preserve successful envelopes and cancellation', async () => {
  const controller = new AbortController();
  globalThis.fetch = (async (url, init) => {
    expect(url).toBe('/api/documents?limit=200');
    expect(init?.signal).toBe(controller.signal);
    init?.signal?.throwIfAborted();
    return Response.json({ ok: true, documents: [] });
  }) as typeof fetch;
  expect(await readSearchSource('/api/documents?limit=200', controller.signal)).toEqual({
    ok: true,
    documents: [],
  });
  controller.abort();
  await expect(readSearchSource('/api/documents?limit=200', controller.signal)).rejects.toThrow();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});
function response(body: string, status = 200) {
  globalThis.fetch = (async () => new Response(body, { status })) as typeof fetch;
}
test('tool requests forward cancellation, custom headers and timezone', async () => {
  const controller = new AbortController();
  let init: RequestInit | undefined;
  globalThis.fetch = (async (url, options) => {
    expect(url).toBe('/api/tools/search_threads');
    init = options;
    return new Response(JSON.stringify({ ok: true, result: { items: [] } }));
  }) as typeof fetch;
  expect(
    await callTool('search_threads', { query: 'plan' }, { 'x-custom': 'value' }, controller.signal),
  ).toEqual({ items: [] });
  expect(init?.signal).toBe(controller.signal);
  expect(init?.body).toBe('{"query":"plan"}');
  expect(new Headers(init?.headers).get('x-custom')).toBe('value');
  expect(new Headers(init?.headers).get('x-user-timezone')).toBeTruthy();
});
test('tool requests remain backwards compatible without a signal', async () => {
  globalThis.fetch = (async (_, options) => {
    expect(options).not.toHaveProperty('signal');
    return new Response('{"result":true}');
  }) as typeof fetch;
  expect(await callTool('list_accounts')).toBe(true);
});
test('tool errors are intentional and never expose an HTML error page', async () => {
  response('{"ok":false,"error":"Unavailable"}');
  await expect(callTool('search')).rejects.toThrow('Unavailable');
  response('<html>private stack trace</html>', 500);
  await expect(callTool('search')).rejects.toThrow('search failed (500)');
  response('not json');
  await expect(callTool('search')).rejects.toThrow('unreadable server response');
  response('');
  await expect(callTool('search')).rejects.toThrow('empty or unreadable');
});
test('cancelled requests propagate AbortError to query cancellation', async () => {
  const controller = new AbortController();
  controller.abort();
  globalThis.fetch = (async (_, init) => {
    init?.signal?.throwIfAborted();
    return new Response('{}');
  }) as typeof fetch;
  await expect(callTool('search', {}, {}, controller.signal)).rejects.toThrow();
});
test('health and tool discovery read their existing endpoints', async () => {
  const urls: unknown[] = [];
  globalThis.fetch = (async (url) => {
    urls.push(url);
    return new Response('{"ok":true}');
  }) as typeof fetch;
  expect(await health()).toEqual({ ok: true });
  expect(await listTools()).toEqual({ ok: true });
  expect(urls).toEqual(['/api/healthz', '/api/tools']);
});
