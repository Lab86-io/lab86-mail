import { describe, expect, test } from 'bun:test';
import { createSurfacePreloader, nextSurfaces, whenBrowserIdle } from '../lib/shell/surface-preload';

describe('surface preload', () => {
  test('a reader of a surface gets the likely next surfaces first', () => {
    expect(nextSurfaces('today')).toEqual(['mail', 'albatrosses']);
    expect(nextSurfaces('mail')).toEqual(['today', 'albatrosses']);
    expect(nextSurfaces('calendar')).toEqual(['today', 'mail']);
  });

  test('each surface loads once, a surface without a loader does nothing, and a failure can retry', async () => {
    const calls: string[] = [];
    let fail = true;
    const preload = createSurfacePreloader({
      today: async () => {
        calls.push('today');
      },
      mail: async () => {
        calls.push('mail');
        if (fail) throw new Error('offline');
      },
    });
    preload('today');
    preload('today');
    preload('chat');
    expect(calls).toEqual(['today']);
    preload('mail');
    await new Promise((resolve) => setTimeout(resolve, 0));
    fail = false;
    preload('mail');
    expect(calls).toEqual(['today', 'mail', 'mail']);
  });

  test('idle work uses the idle callback and can be cancelled', () => {
    const events: string[] = [];
    const cancel = whenBrowserIdle(() => events.push('ran'), {
      requestIdleCallback: (callback) => {
        callback();
        return 7;
      },
      cancelIdleCallback: (handle) => events.push(`cancel:${handle}`),
      setTimeout: () => 0,
      clearTimeout: () => undefined,
    });
    cancel();
    expect(events).toEqual(['ran', 'cancel:7']);
  });

  test('a browser without an idle callback uses a timer, and data saver skips the work', () => {
    const events: string[] = [];
    const cancel = whenBrowserIdle(() => events.push('ran'), {
      setTimeout: (callback, delay) => {
        events.push(`wait:${delay}`);
        callback();
        return 3;
      },
      clearTimeout: (handle) => events.push(`clear:${handle}`),
    });
    cancel();
    expect(events).toEqual(['wait:1500', 'ran', 'clear:3']);

    const skipped: string[] = [];
    whenBrowserIdle(() => skipped.push('ran'), {
      navigator: { connection: { saveData: true } },
      setTimeout: () => 0,
      clearTimeout: () => undefined,
    })();
    expect(skipped).toEqual([]);
  });
});
