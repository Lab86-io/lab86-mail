import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { POST as backfillPost } from '../app/api/mail/corpus/backfill/route';
import { POST as reconcilePost } from '../app/api/mail/corpus/reconcile/route';
import { constantTimeEqual, requireInternalSecret } from '../convex/lib';

const previous = process.env.LAB86_CONVEX_INTERNAL_SECRET;
beforeEach(() => {
  process.env.LAB86_CONVEX_INTERNAL_SECRET = 'internal-secret-value';
});
afterEach(() => {
  if (previous === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previous;
});

describe('Convex internal secret', () => {
  test('accepts only the exact secret', () => {
    expect(() => requireInternalSecret('internal-secret-value')).not.toThrow();
    for (const wrong of [undefined, '', 'internal-secret-valuE', 'internal-secret-value-longer', 'short']) {
      expect(() => requireInternalSecret(wrong)).toThrow('Invalid Convex internal secret.');
    }
  });

  test('a missing configuration gets the same message as a wrong secret', () => {
    delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
    expect(() => requireInternalSecret('anything')).toThrow('Invalid Convex internal secret.');
    expect(() => requireInternalSecret(undefined)).toThrow('Invalid Convex internal secret.');
  });

  test('constantTimeEqual compares length and every character', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', 'a')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });
});

describe('corpus routes check the internal secret', () => {
  const routes = [
    ['backfill', backfillPost],
    ['reconcile', reconcilePost],
  ] as const;

  function request(name: string, headers: Record<string, string>) {
    return new NextRequest(`https://mail.lab86.io/api/mail/corpus/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ userId: 'u' }),
    });
  }

  test('reject a missing, wrong, or wrong-length secret with one message', async () => {
    for (const [name, post] of routes) {
      for (const headers of [
        {},
        { 'x-lab86-internal-secret': 'internal-secret-valuE' },
        { authorization: 'Bearer internal-secret' },
      ]) {
        const response = await post(request(name, headers));
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ ok: false, error: 'Unauthorized.' });
      }
    }
  });

  test('reject every call when the secret is not configured', async () => {
    delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
    for (const [name, post] of routes) {
      const response = await post(request(name, { 'x-lab86-internal-secret': '' }));
      expect(response.status).toBe(401);
    }
  });

  test('accept the secret in the header or as a bearer token', async () => {
    for (const [name, post] of routes) {
      for (const headers of [
        { 'x-lab86-internal-secret': 'internal-secret-value' },
        { authorization: 'Bearer internal-secret-value' },
      ]) {
        // Past the gate, the body check answers 400 (userId without accountId).
        const response = await post(request(name, headers));
        expect(response.status).toBe(400);
      }
    }
  });
});
