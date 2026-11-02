import { describe, expect, test } from 'bun:test';
import { createBriefHeadGet, createBriefViewPost } from '../app/api/brief/view/route';
import { getAiRequestContext } from '../lib/ai/context';
import { AuthRequiredError } from '../lib/auth/current-user';
import { enforceLocalRateLimit, RateLimitError } from '../lib/rate-limit';

function deps(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      requireCurrentUser: async () => ({ userId: 'reader', email: '', name: '', source: 'clerk' }),
      enforceUserRateLimit: async () => {
        calls.push('rate');
      },
      enforceLocalRateLimit: () => {
        calls.push('local');
      },
      readBriefHead: async () => {
        calls.push(`head:${getAiRequestContext().userId}`);
        return { stamp: 'idle', pending: null };
      },
      readBriefView: async (known?: string | null) => {
        calls.push(`view:${known ?? ''}:${getAiRequestContext().userId}`);
        return { stamp: 'idle', pending: null, revision: 'rev', report: null };
      },
      readBriefEditionView: async (id: string, known?: string | null) => {
        calls.push(`edition:${id}:${known ?? ''}`);
        return { stamp: 'idle', pending: null, revision: 'rev', report: null };
      },
      ...overrides,
    } as any,
  };
}
const post = (body: unknown) =>
  new Request('https://mail.test/api/brief/view', { method: 'POST', body: JSON.stringify(body) });

describe('the brief view route', () => {
  test('the poll costs no Convex rate mutation', async () => {
    const { deps: injected, calls } = deps();
    const response = await createBriefHeadGet(injected)();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stamp: 'idle', pending: null });
    expect(calls).toEqual(['local', 'head:reader']);
  });

  test('a full read is rate limited and runs as the signed-in user', async () => {
    const { deps: injected, calls } = deps();
    const response = await createBriefViewPost(injected)(post({ known: 'abc' }));
    expect(response.status).toBe(200);
    expect(calls).toEqual(['rate', 'view:abc:reader']);
  });

  test('an id reads one edition from history', async () => {
    const { deps: injected, calls } = deps();
    await createBriefViewPost(injected)(post({ id: 'old', known: null }));
    expect(calls).toEqual(['rate', 'edition:old:']);
  });

  test('a bad body is a 400, and an empty body is a latest read', async () => {
    const { deps: injected, calls } = deps();
    const bad = await createBriefViewPost(injected)(post({ id: 42 }));
    expect(bad.status).toBe(400);
    const empty = await createBriefViewPost(injected)(
      new Request('https://mail.test/api/brief/view', { method: 'POST', body: 'not json' }),
    );
    expect(empty.status).toBe(200);
    expect(calls).toContain('view::reader');
  });

  test('no session is a 401, a limit is a 429, and an unknown error tells nothing', async () => {
    const signedOut = deps({
      requireCurrentUser: async () => {
        throw new AuthRequiredError('Sign in required');
      },
    }).deps;
    expect((await createBriefHeadGet(signedOut)()).status).toBe(401);
    expect((await createBriefViewPost(signedOut)(post({}))).status).toBe(401);

    const limited = deps({
      enforceLocalRateLimit: () => {
        throw new RateLimitError('Too many requests.', 1_000, 120);
      },
    }).deps;
    expect((await createBriefHeadGet(limited)()).status).toBe(429);

    const errors = console.error;
    console.error = () => undefined;
    try {
      const broken = deps({
        readBriefView: async () => {
          throw new Error('secret provider detail');
        },
      }).deps;
      const response = await createBriefViewPost(broken)(post({}));
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Could not load the brief.' });
    } finally {
      console.error = errors;
    }
  });
});

describe('the local rate guard', () => {
  test('it stops a noisy client within the window and opens the next window', () => {
    const options = { userId: `user-${Math.random()}`, key: 'head', limit: 2, windowMs: 1_000 };
    enforceLocalRateLimit(options, 0);
    enforceLocalRateLimit(options, 10);
    expect(() => enforceLocalRateLimit(options, 20)).toThrow(RateLimitError);
    enforceLocalRateLimit(options, 1_001);
  });

  test('it keeps a bounded key count', () => {
    for (let index = 0; index < 5_100; index += 1)
      enforceLocalRateLimit({ userId: `bulk-${index}`, key: 'head', limit: 1, windowMs: 1_000 }, 0);
    expect(() =>
      enforceLocalRateLimit({ userId: 'bulk-5099', key: 'head', limit: 1, windowMs: 1_000 }, 1),
    ).toThrow(RateLimitError);
  });
});
