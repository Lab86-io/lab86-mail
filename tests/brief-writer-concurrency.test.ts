import { expect, test } from 'bun:test';
import { concurrencyLimit, startConcurrent } from '../lib/classifier/client';
import {
  INSIGHT_CONCURRENCY,
  SEARCH_CACHE_CONCURRENCY,
  searchAccountThreads,
} from '../lib/mail/daily-report';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('the gate runs at most its limit at once, in arrival order', async () => {
  const gate = concurrencyLimit(2);
  const started: number[] = [];
  const gates = [0, 1, 2, 3].map(() => deferred());
  const runs = gates.map((entry, index) =>
    gate(async () => {
      started.push(index);
      await entry.promise;
      return index;
    }),
  );
  await tick();
  expect(started).toEqual([0, 1]);
  gates[1].resolve();
  await tick();
  expect(started).toEqual([0, 1, 2]);
  gates[0].reject(new Error('failed task'));
  await expect(runs[0]).rejects.toThrow('failed task');
  await tick();
  // A failed task also gives its place to the next one.
  expect(started).toEqual([0, 1, 2, 3]);
  gates[2].resolve();
  gates[3].resolve();
  expect(await Promise.all(runs.slice(1))).toEqual([1, 2, 3]);
  // After all ended, new tasks start at once again.
  const after = concurrencyLimit(0);
  expect(await after(async () => 'one at a time')).toBe('one at a time');
});

test('keyed starts run only the selected items and keep one promise per key', async () => {
  let running = 0;
  let peak = 0;
  const calls: string[] = [];
  const started = startConcurrent(
    ['a', 'b', 'skip', 'c', 'a', 'd', 'e'],
    (item) => (item === 'skip' ? null : item),
    async (item) => {
      calls.push(item);
      running += 1;
      peak = Math.max(peak, running);
      await tick();
      running -= 1;
      if (item === 'e') throw new Error('not awaited');
      return item.toUpperCase();
    },
    INSIGHT_CONCURRENCY,
  );
  expect([...started.keys()]).toEqual(['a', 'b', 'c', 'd', 'e']);
  expect(await started.get('a')).toBe('A');
  expect(await started.get('d')).toBe('D');
  await tick();
  await tick();
  expect(calls.sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  expect(peak).toBe(INSIGHT_CONCURRENCY);
  // The rejection of 'e' was never awaited and did not fail the test run.
  await expect(started.get('e')!).rejects.toThrow('not awaited');
});

test('a candidate search writes its thread cache rows in parallel and ignores a failed write', async () => {
  let running = 0;
  let peak = 0;
  const written: string[] = [];
  const threads = Array.from({ length: 20 }, (_, index) => ({ _id: `t${index}`, subject: `S${index}` }));
  const result = await searchAccountThreads('acct', 'in:inbox', 50, 'owner', {
    searchNylasThreads: (async (input: any) => {
      expect(input).toEqual({ userId: 'owner', account: 'acct', query: 'in:inbox', max: 50 });
      return { items: [...threads, { _id: '' }] };
    }) as any,
    upsertThread: (async (account: string, thread: any) => {
      expect(account).toBe('acct');
      running += 1;
      peak = Math.max(peak, running);
      await tick();
      running -= 1;
      if (thread._id === 't3') throw new Error('write failed');
      written.push(thread._id);
      return thread;
    }) as any,
  });
  expect(result.map((thread) => thread._id)).toEqual(threads.map((thread) => thread._id));
  expect(written).toHaveLength(19);
  expect(peak).toBe(SEARCH_CACHE_CONCURRENCY);
  const empty = await searchAccountThreads('acct', 'q', 5, null, {
    searchNylasThreads: (async () => null) as any,
    upsertThread: (async () => {
      throw new Error('not called');
    }) as any,
  });
  expect(empty).toEqual([]);
});
