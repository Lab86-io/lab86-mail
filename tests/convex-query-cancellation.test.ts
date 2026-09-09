import { expect, test } from 'bun:test';
import { makeFunctionReference } from 'convex/server';
import { convexQuery } from '../lib/hosted/convex';

test('scoped cancellation clients retain the explicit missing configuration error', async () => {
  const saved = [process.env.NEXT_PUBLIC_CONVEX_URL, process.env.CONVEX_DEPLOYMENT];
  delete process.env.NEXT_PUBLIC_CONVEX_URL;
  delete process.env.CONVEX_DEPLOYMENT;
  try {
    await expect(
      convexQuery(makeFunctionReference('narrative:search'), {}, new AbortController().signal),
    ).rejects.toThrow('Convex is not configured');
  } finally {
    for (const [i, key] of ['NEXT_PUBLIC_CONVEX_URL', 'CONVEX_DEPLOYMENT'].entries()) {
      if (saved[i] === undefined) delete process.env[key];
      else process.env[key] = saved[i];
    }
  }
});

test('narrative cancellation reaches the scoped Convex fetch without sharing signals', async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  const signals: Array<AbortSignal | null | undefined> = [];
  globalThis.fetch = (async (_url, init) => {
    signals.push(init?.signal);
    return Response.json({ status: 'success', value: { ok: true } });
  }) as typeof fetch;
  try {
    for (const url of ['http://127.0.0.1:9999', 'https://synthetic-test.convex.cloud']) {
      process.env.NEXT_PUBLIC_CONVEX_URL = url;
      const controller = new AbortController();
      expect(
        await convexQuery(
          makeFunctionReference('narrative:search'),
          { userId: 'synthetic' },
          controller.signal,
        ),
      ).toEqual({ ok: true });
      expect(signals.at(-1)).toBe(controller.signal);
      controller.abort();
      await expect(
        convexQuery(makeFunctionReference('narrative:search'), {}, controller.signal),
      ).rejects.toThrow();
    }
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_CONVEX_URL;
    else process.env.NEXT_PUBLIC_CONVEX_URL = originalUrl;
  }
});
