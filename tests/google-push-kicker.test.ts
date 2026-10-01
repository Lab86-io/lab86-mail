import { describe, expect, test } from 'bun:test';
import { createPushKicker, type PushKickOutcome } from '../lib/google/push/kicker';

/** A scheduler that runs timers only when the test says so. */
function manualClock() {
  const timers: Array<{ fn: () => void; ms: number }> = [];
  return {
    timers,
    schedule: (fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    async fire() {
      const timer = timers.shift();
      timer?.fn();
      // Let the run and its promise chain settle.
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
      return timer?.ms;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('push kicker', () => {
  test('a burst of kicks starts one run after the delay', async () => {
    const clock = manualClock();
    const runs: string[] = [];
    const kicker = createPushKicker<string>({
      delayMs: 2000,
      retryDelayMs: 5000,
      maxChain: 3,
      schedule: clock.schedule,
      run: async (input) => {
        runs.push(input);
        return 'done';
      },
    });
    expect(kicker.kick('a', 'first')).toBe('scheduled');
    expect(kicker.kick('a', 'second')).toBe('coalesced');
    expect(kicker.kick('a', 'third')).toBe('coalesced');
    expect(clock.timers.map((t) => t.ms)).toEqual([2000]);
    await clock.fire();
    expect(runs).toEqual(['third']);
    expect(kicker.pending()).toBe(0);
  });

  test('keys do not share a debounce', async () => {
    const clock = manualClock();
    const runs: string[] = [];
    const kicker = createPushKicker<string>({
      delayMs: 1000,
      retryDelayMs: 1000,
      maxChain: 1,
      schedule: clock.schedule,
      run: async (input) => {
        runs.push(input);
        return 'done';
      },
    });
    kicker.kick('a', 'a1');
    kicker.kick('b', 'b1');
    await clock.fire();
    await clock.fire();
    expect(runs.sort()).toEqual(['a1', 'b1']);
  });

  test('a kick during a run starts one more run after it, so the change is not lost', async () => {
    const clock = manualClock();
    const runs: string[] = [];
    const gate = deferred<PushKickOutcome>();
    const kicker = createPushKicker<string>({
      delayMs: 2000,
      retryDelayMs: 5000,
      maxChain: 3,
      schedule: clock.schedule,
      run: async (input) => {
        runs.push(input);
        return runs.length === 1 ? gate.promise : 'done';
      },
    });
    kicker.kick('a', 'one');
    await clock.fire();
    expect(kicker.kick('a', 'two')).toBe('queued');
    expect(kicker.kick('a', 'three')).toBe('queued');
    gate.resolve('done');
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(clock.timers.map((t) => t.ms)).toEqual([2000]);
    await clock.fire();
    expect(runs).toEqual(['one', 'three']);
    expect(kicker.pending()).toBe(0);
  });

  test('a run that answers again runs once more after the retry delay, up to the chain limit', async () => {
    const clock = manualClock();
    let runs = 0;
    const kicker = createPushKicker<string>({
      delayMs: 100,
      retryDelayMs: 5000,
      maxChain: 2,
      schedule: clock.schedule,
      run: async () => {
        runs += 1;
        return 'again';
      },
    });
    kicker.kick('a', 'x');
    expect(await clock.fire()).toBe(100);
    expect(await clock.fire()).toBe(5000);
    expect(await clock.fire()).toBe(5000);
    expect(clock.timers).toHaveLength(0);
    expect(runs).toBe(3);
    expect(kicker.pending()).toBe(0);
  });

  test('a failed run is reported and ends the chain', async () => {
    const clock = manualClock();
    const errors: Array<[string, unknown]> = [];
    const kicker = createPushKicker<string>({
      delayMs: 10,
      retryDelayMs: 10,
      maxChain: 5,
      schedule: clock.schedule,
      reportError: (key, error) => errors.push([key, error]),
      run: async () => {
        throw new Error('boom');
      },
    });
    kicker.kick('k', 'x');
    await clock.fire();
    expect(errors).toHaveLength(1);
    expect(errors[0][0]).toBe('k');
    expect(clock.timers).toHaveLength(0);
  });

  test('the default scheduler and error report work', async () => {
    const original = console.error;
    const logged: unknown[] = [];
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      const done = deferred<void>();
      const kicker = createPushKicker<string>({
        delayMs: 1,
        retryDelayMs: 1,
        maxChain: 0,
        run: async () => {
          done.resolve();
          throw new Error('default report');
        },
      });
      kicker.kick('k', 'x');
      await done.promise;
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(logged).toHaveLength(1);
    } finally {
      console.error = original;
    }
  });
});
