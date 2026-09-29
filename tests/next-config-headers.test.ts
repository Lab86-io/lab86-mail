import { afterEach, describe, expect, test } from 'bun:test';
import config from '../next.config';

const previousNodeEnv = process.env.NODE_ENV;
afterEach(() => {
  (process.env as Record<string, string | undefined>).NODE_ENV = previousNodeEnv;
});

function setNodeEnv(value: string) {
  (process.env as Record<string, string | undefined>).NODE_ENV = value;
}

describe('security headers', () => {
  test('production builds send HSTS, nosniff, framing, referrer, and permissions headers on every path', async () => {
    setNodeEnv('production');
    const rules = await config.headers!();
    expect(rules).toHaveLength(2);
    expect(rules[0].source).toBe('/:path*');
    const headers = Object.fromEntries(rules[0].headers.map((header) => [header.key, header.value]));
    expect(headers['Strict-Transport-Security']).toMatch(/^max-age=\d{7,}/);
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('SAMEORIGIN');
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['Permissions-Policy']).toContain('camera=()');
    // The page policy needs a fresh nonce per request, so proxy.ts sends it.
    expect(headers['Content-Security-Policy']).toBeUndefined();
    // API responses keep the framing rule, apart from the routes with their own policy.
    expect(rules[1].source).toBe('/api/:path((?!attachments/|albatross/plan/).*)');
    expect(rules[1].headers).toEqual([{ key: 'Content-Security-Policy', value: "frame-ancestors 'self'" }]);
  });

  test('dev servers get no security headers', async () => {
    setNodeEnv('development');
    expect(await config.headers!()).toEqual([]);
  });
});
