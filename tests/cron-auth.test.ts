import { describe, expect, test } from 'bun:test';
import { isInternalCronRequest } from '../lib/cron-auth';

function cronRequest(headers: Record<string, string>) {
  return {
    headers: {
      get(name: string) {
        return headers[name.toLowerCase()] ?? null;
      },
    },
  } as any;
}

describe('isInternalCronRequest', () => {
  test('accepts matching internal secret headers', () => {
    const previous = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'cron-secret';
    try {
      expect(isInternalCronRequest(cronRequest({ 'x-lab86-internal-secret': 'cron-secret' }))).toBe(true);
      expect(isInternalCronRequest(cronRequest({ authorization: 'Bearer cron-secret' }))).toBe(true);
      expect(isInternalCronRequest(cronRequest({ 'x-lab86-internal-secret': 'wrong' }))).toBe(false);
      expect(isInternalCronRequest(cronRequest({}))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previous;
    }
  });
  test('rejects when secret is not configured', () => {
    const previous = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
    try {
      expect(isInternalCronRequest(cronRequest({ 'x-lab86-internal-secret': 'anything' }))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previous;
    }
  });
});
