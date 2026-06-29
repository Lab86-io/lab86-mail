import { describe, expect, test } from 'bun:test';
import { GET } from '../app/api/logos/[domain]/route';

describe('/api/logos/[domain]', () => {
  test('does not negative-cache transient upstream logo failures', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) return new Response(null, { status: 500 });
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    try {
      const response = await GET(new Request('https://example.test/api/logos/microsoft.com'), {
        params: Promise.resolve({ domain: 'microsoft.com' }),
      });
      expect(response.status).toBe(502);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(calls).toBeGreaterThan(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('negative-caches clean logo misses', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;

    try {
      const response = await GET(new Request('https://example.test/api/logos/example.invalid'), {
        params: Promise.resolve({ domain: 'example.invalid' }),
      });
      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toContain('max-age=86400');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
