import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { GET } from '../app/api/healthz/route';

const previous = process.env.LAB86_CONVEX_INTERNAL_SECRET;
beforeEach(() => {
  process.env.LAB86_CONVEX_INTERNAL_SECRET = 'health-secret';
});
afterEach(() => {
  if (previous === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previous;
});

const request = (headers: Record<string, string> = {}) =>
  new NextRequest('https://mail.lab86.io/api/healthz', { headers });

describe('healthz', () => {
  test('a public caller gets only the status', async () => {
    for (const headers of [{}, { 'x-lab86-internal-secret': 'wrong-secret!' }]) {
      const response = await GET(request(headers));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    }
  });

  test('a caller with the internal secret gets the details', async () => {
    const response = await GET(request({ 'x-lab86-internal-secret': 'health-secret' }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.service).toBe('lab86-mail');
    expect(body).toHaveProperty('railway');
    expect(body).toHaveProperty('ai');
    expect(body).toHaveProperty('hosted');
  });
});
