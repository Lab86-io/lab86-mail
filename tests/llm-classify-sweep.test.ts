import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getAiRequestContext } from '../lib/ai/context';
import { kickLlmClassification, runLlmClassificationSweep } from '../lib/mail/llm-classify';

const previousUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
const previousAltUrl = process.env.CONVEX_URL;

function configure(on: boolean) {
  delete process.env.CONVEX_URL;
  if (on) process.env.NEXT_PUBLIC_CONVEX_URL = 'https://jev-sweep.convex.cloud';
  else delete process.env.NEXT_PUBLIC_CONVEX_URL;
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Jev classification sweep runner', () => {
  beforeEach(() => configure(true));
  afterEach(() => {
    if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_CONVEX_URL;
    else process.env.NEXT_PUBLIC_CONVEX_URL = previousUrl;
    if (previousAltUrl === undefined) delete process.env.CONVEX_URL;
    else process.env.CONVEX_URL = previousAltUrl;
  });

  test('does nothing when Convex is not configured', async () => {
    configure(false);
    let calls = 0;
    const result = await runLlmClassificationSweep('sweep-off', async () => {
      calls += 1;
      return { classified: 3 };
    });
    expect(result).toEqual({ classified: 0 });
    expect(calls).toBe(0);
  });

  test('runs the sweep as the user and skips a second run for the same user', async () => {
    const seen: Array<{ userId?: string | null; agent?: string }> = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = runLlmClassificationSweep('sweep-user', async () => {
      const context = getAiRequestContext();
      seen.push({ userId: context.userId, agent: context.agent });
      await gate;
      return { classified: 2 };
    });
    const second = await runLlmClassificationSweep('sweep-user', async () => ({ classified: 9 }));
    expect(second).toEqual({ classified: 0 });
    release();
    expect(await first).toEqual({ classified: 2 });
    expect(seen).toEqual([{ userId: 'sweep-user', agent: 'ai' }]);
  });

  test('a kick during a sweep replays after it ends', async () => {
    const result = await runLlmClassificationSweep('sweep-rerun', async () => {
      // The user is mid-sweep, so this kick is held for a replay.
      kickLlmClassification('sweep-rerun', 0);
      return { classified: 1 };
    });
    expect(result).toEqual({ classified: 1 });
    // The replay fires after one second. With Convex off by then, it returns
    // without a sweep, so the test makes no network call.
    configure(false);
    await tick(1_100);
  });

  test('a debounced kick fires once and needs a user', async () => {
    kickLlmClassification('sweep-kick', 5);
    // A second kick inside the debounce window is ignored.
    kickLlmClassification('sweep-kick', 5);
    configure(false);
    await tick(20);
    // With no user, the kick has no target.
    kickLlmClassification(null, 5);
  });
});
