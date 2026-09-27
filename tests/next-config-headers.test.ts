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
  test('production builds send HSTS, nosniff, frame-ancestors, and a referrer policy on every path', async () => {
    setNodeEnv('production');
    const rules = await config.headers!();
    expect(rules).toHaveLength(1);
    expect(rules[0].source).toBe('/:path*');
    const headers = Object.fromEntries(rules[0].headers.map((header) => [header.key, header.value]));
    expect(headers['Strict-Transport-Security']).toMatch(/^max-age=\d{7,}/);
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    // Frame rules only: a script policy would break Clerk, Convex, and Collabora.
    expect(headers['Content-Security-Policy']).toBe("frame-ancestors 'self'");
  });

  test('dev servers get no security headers', async () => {
    setNodeEnv('development');
    expect(await config.headers!()).toEqual([]);
  });
});
