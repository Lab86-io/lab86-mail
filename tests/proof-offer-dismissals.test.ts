import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createProofDismissalsPost } from '../app/api/albatross/proof-matches/dismissals/route';
import { createProofMatchesPost } from '../app/api/albatross/proof-matches/route';
import { runWithAiRequestContext } from '../lib/ai/context';
import {
  dismissProofMatches,
  moveDeviceProofDismissals,
  PROOF_DISMISSALS_KEY,
  proofPairKey,
  withoutDismissedProofMatches,
} from '../lib/shell/proof-dismissals';
import { dismissedProofWorkIds, dismissProofWork } from '../lib/store/proof-dismissals';

function memory(keys?: string[]) {
  const saved = new Map<string, string>(keys ? [[PROOF_DISMISSALS_KEY, JSON.stringify(keys)]] : []);
  return {
    saved,
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => void saved.set(key, value),
    removeItem: (key: string) => void saved.delete(key),
  };
}

/** A fake dismissals route that records each batch. */
function dismissalServer(options: { fail?: boolean } = {}) {
  const batches: Array<Array<{ accountId: string; providerThreadId: string; workId: string }>> = [];
  const fetcher = mock(async (url: string, init: RequestInit) => {
    expect(url).toBe('/api/albatross/proof-matches/dismissals');
    if (options.fail) return Response.json({ ok: false, error: 'down' }, { status: 500 });
    batches.push(JSON.parse(String(init.body)).dismissals);
    return Response.json({ ok: true });
  });
  return { fetcher, batches };
}

describe('Not related on the client', () => {
  test('a dismissal goes to the server for each Work in the offer', async () => {
    const server = dismissalServer();
    const store = memory();
    await dismissProofMatches('acc', 'thread-1', ['passport', 'refund'], server.fetcher, store);
    expect(server.batches).toEqual([
      [
        { accountId: 'acc', providerThreadId: 'thread-1', workId: 'passport' },
        { accountId: 'acc', providerThreadId: 'thread-1', workId: 'refund' },
      ],
    ]);
    expect(store.saved.has(PROOF_DISMISSALS_KEY)).toBe(false);
    await dismissProofMatches('acc', 'thread-1', [], server.fetcher, store);
    expect(server.batches).toHaveLength(1);
  });

  test('a failed save stays on the device and still hides the offer there', async () => {
    const store = memory();
    await dismissProofMatches(
      'acc',
      'thread-1',
      ['passport'],
      dismissalServer({ fail: true }).fetcher,
      store,
    );
    await dismissProofMatches(
      'acc',
      'thread-1',
      ['passport'],
      dismissalServer({ fail: true }).fetcher,
      store,
    );
    expect(JSON.parse(store.saved.get(PROOF_DISMISSALS_KEY) || '[]')).toHaveLength(1);
    const matches = [{ workId: 'passport' }, { workId: 'refund' }];
    expect(withoutDismissedProofMatches('acc', 'thread-1', matches, store)).toEqual([{ workId: 'refund' }]);
    expect(withoutDismissedProofMatches('acc', 'thread-2', matches, store)).toEqual(matches);
    expect(withoutDismissedProofMatches('other', 'thread-1', matches, store)).toEqual(matches);
  });

  test('device pairs from an earlier version move to the server in batches, then leave the device', async () => {
    const keys = Array.from({ length: 150 }, (_, i) => proofPairKey('acc', `t${i}`, 'w'));
    const store = memory([...keys, 'not-a-pair']);
    const server = dismissalServer();
    expect(await moveDeviceProofDismissals(server.fetcher, store)).toBe(150);
    expect(server.batches.map((batch) => batch.length)).toEqual([100, 50]);
    expect(server.batches[0][0]).toEqual({ accountId: 'acc', providerThreadId: 't0', workId: 'w' });
    expect(store.saved.has(PROOF_DISMISSALS_KEY)).toBe(false);
    expect(await moveDeviceProofDismissals(server.fetcher, store)).toBe(0);
    expect(server.batches).toHaveLength(2);
  });

  test('device pairs stay on the device when the server cannot take them', async () => {
    const store = memory([proofPairKey('acc', 't', 'w')]);
    await expect(moveDeviceProofDismissals(dismissalServer({ fail: true }).fetcher, store)).rejects.toThrow(
      'down',
    );
    expect(store.saved.has(PROOF_DISMISSALS_KEY)).toBe(true);
  });

  test('bad or blocked storage never hides an offer or throws', async () => {
    const bad = { getItem: () => '{nope', setItem: () => {}, removeItem: () => {} };
    expect(withoutDismissedProofMatches('a', 't', [{ workId: 'w' }], bad)).toHaveLength(1);
    const blocked = {
      getItem: () => null,
      setItem: () => {
        throw new Error('full');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    await dismissProofMatches('a', 't', ['w'], dismissalServer({ fail: true }).fetcher, blocked);
    expect(withoutDismissedProofMatches('a', 't', [{ workId: 'w' }], null)).toHaveLength(1);
    const stuck = { ...memory([proofPairKey('a', 't', 'w')]), removeItem: blocked.removeItem };
    expect(await moveDeviceProofDismissals(dismissalServer().fetcher, stuck)).toBe(1);
  });
});

describe('Not related on the server', () => {
  const asUser = <T>(userId: string, run: () => Promise<T>) =>
    runWithAiRequestContext({ userId, agent: 'user' }, run);

  test('the store keeps each Work and thread pair for its user only', async () => {
    await asUser('store-user-1', () =>
      dismissProofWork([
        { accountId: 'acc', threadId: 'thread-1', workId: 'passport' },
        { accountId: 'acc', threadId: 'thread-1', workId: 'passport' },
        { accountId: 'acc', threadId: 'thread-2', workId: 'refund' },
      ]),
    );
    expect(await asUser('store-user-1', () => dismissedProofWorkIds('acc', 'thread-1'))).toEqual(
      new Set(['passport']),
    );
    expect(await asUser('store-user-1', () => dismissedProofWorkIds('other', 'thread-1'))).toEqual(new Set());
    expect(await asUser('store-user-2', () => dismissedProofWorkIds('acc', 'thread-1'))).toEqual(new Set());
    expect(await asUser('store-user-1', () => dismissedProofWorkIds('', 'thread-1'))).toEqual(new Set());
  });

  test('one thread keeps only its newest dismissed Work', async () => {
    await asUser('store-user-3', async () => {
      await dismissProofWork(
        Array.from({ length: 105 }, (_, i) => ({ accountId: 'a', threadId: 't', workId: `w${i}` })),
      );
      const kept = await dismissedProofWorkIds('a', 't');
      expect(kept.size).toBe(100);
      expect(kept.has('w0')).toBe(false);
      expect(kept.has('w104')).toBe(true);
    });
  });

  const post = (body: unknown) =>
    new NextRequest('http://localhost/api/albatross/proof-matches/dismissals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  let saved: unknown[];
  let route: ReturnType<typeof createProofDismissalsPost>;
  beforeEach(() => {
    saved = [];
    route = createProofDismissalsPost({
      requireCurrentUser: mock(async () => ({ userId: 'route-user' })) as any,
      enforceUserRateLimit: mock(async () => undefined) as any,
      dismissProofWork: mock(async (pairs: unknown[]) => {
        saved.push(...pairs);
        return 1;
      }) as any,
    });
  });

  test('the dismissals route saves valid pairs for the signed-in user', async () => {
    const response = await route(
      post({ dismissals: [{ accountId: 'acc', providerThreadId: 'thread-1', workId: 'passport' }] }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, saved: 1, threads: 1 });
    expect(saved).toEqual([{ accountId: 'acc', threadId: 'thread-1', workId: 'passport' }]);
  });

  test('the dismissals route refuses an empty, bad, or oversized request', async () => {
    const pair = { accountId: 'acc', providerThreadId: 't', workId: 'w' };
    for (const body of [
      '{bad',
      {},
      { dismissals: [] },
      { dismissals: [{ ...pair, workId: '' }] },
      { dismissals: Array.from({ length: 101 }, () => pair) },
    ]) {
      expect((await route(post(body))).status).toBe(400);
    }
    expect(saved).toEqual([]);
  });

  test('the dismissals route needs a session', async () => {
    const { AuthRequiredError } = await import('../lib/auth/current-user');
    const signedOut = createProofDismissalsPost({
      requireCurrentUser: mock(async () => {
        throw new AuthRequiredError();
      }) as any,
    });
    expect((await signedOut(post({ dismissals: [] }))).status).toBe(401);
  });

  test('the proof-match route leaves out a dismissed pair before the gate runs', async () => {
    const work = (id: string, title: string) => ({
      _id: id,
      title,
      contract: { outcome: title, proofs: [{ id: 'p', what: `${title} confirmation arrived` }] },
    });
    const gate = mock(async () => ({ satisfies: true, reason: 'ok' }));
    const dismissedWorkIds = mock(async () => new Set(['sheets']));
    const matches = createProofMatchesPost({
      requireCurrentUser: mock(async () => ({ userId: 'route-user' })) as any,
      enforceUserRateLimit: mock(async () => undefined) as any,
      convexQuery: mock(async (_fn: unknown, args: any) =>
        args.providerThreadId
          ? null
          : [work('sheets', 'Order linen sheets'), work('towels', 'Order linen towels')],
      ) as any,
      evidenceSatisfies: gate as any,
      dismissedWorkIds,
    });
    const response = await matches(
      new NextRequest('http://localhost/api/albatross/proof-matches', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subject: 'Your linen sheets and towels order confirmation',
          snippet: 'Order linen sheets towels confirmation arrived',
          accountId: 'acc',
          providerThreadId: 'thread-1',
        }),
      }),
    );
    const body = await response.json();
    expect(dismissedWorkIds).toHaveBeenCalledWith('route-user', 'acc', 'thread-1');
    expect(body.candidates.map((candidate: any) => candidate.workId)).toEqual(['towels']);
    expect(gate).toHaveBeenCalledTimes(1);
  });

  test('a failed dismissal lookup never hides an offer', async () => {
    const matches = createProofMatchesPost({
      requireCurrentUser: mock(async () => ({ userId: 'route-user' })) as any,
      enforceUserRateLimit: mock(async () => undefined) as any,
      convexQuery: mock(async (_fn: unknown, args: any) =>
        args.providerThreadId
          ? null
          : [
              {
                _id: 'sheets',
                title: 'Order linen sheets',
                contract: { outcome: 'Order linen sheets', proofs: [] },
              },
            ],
      ) as any,
      evidenceSatisfies: mock(async () => ({ satisfies: true, reason: 'ok' })) as any,
      dismissedWorkIds: mock(async () => {
        throw new Error('store down');
      }),
    });
    const response = await matches(
      new NextRequest('http://localhost/api/albatross/proof-matches', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subject: 'Linen sheets order',
          snippet: 'Order linen sheets confirmation',
          accountId: 'acc',
          providerThreadId: 'thread-1',
        }),
      }),
    );
    expect((await response.json()).candidates.map((candidate: any) => candidate.workId)).toEqual(['sheets']);
  });
});
