import { afterEach, expect, spyOn, test } from 'bun:test';
import { constantTimeEqual, fanOutInternalPost } from '../convex/lib';

// fanOutInternalPost counts the 2xx answers. A failed answer, a fetch that
// throws, and a call past its time limit are logged and do not stop the run.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('counts the good answers and logs each failure', async () => {
  const errors = spyOn(console, 'error').mockImplementation(() => undefined);
  const seen: Array<{ body: { userId?: string }; secret: string | null }> = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    seen.push({ body, secret: new Headers(init?.headers).get('x-lab86-internal-secret') });
    if (body.userId === 'bad') return new Response('', { status: 500 });
    if (body.userId === 'down') throw new Error('network');
    if (body.userId === 'slow')
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    return new Response('{}');
  }) as typeof fetch;
  try {
    const ok = await fanOutInternalPost(
      'https://app.example/api/cron/x',
      'secret',
      [{ userId: 'a' }, { userId: 'bad' }, { userId: 'down' }, { userId: 'slow' }, { userId: 'b' }],
      { concurrency: 2, timeoutMs: 5, label: 'test' },
    );
    expect(ok).toBe(2);
    expect(seen.map((call) => call.body.userId)).toEqual(['a', 'bad', 'down', 'slow', 'b']);
    expect(seen.every((call) => call.secret === 'secret')).toBe(true);
    const lines = errors.mock.calls.map((call) => String(call[0]));
    expect(lines).toContain('[test] app returned 500 for {"userId":"bad"}');
    expect(lines.filter((line) => line.startsWith('[test] fetch failed'))).toHaveLength(2);
  } finally {
    errors.mockRestore();
  }
});

test('the internal secret compare needs the same value', () => {
  expect(constantTimeEqual('secret', 'secret')).toBe(true);
  expect(constantTimeEqual('secre', 'secret')).toBe(false);
  expect(constantTimeEqual('secret!', 'secret')).toBe(false);
  expect(constantTimeEqual('', 'secret')).toBe(false);
});
