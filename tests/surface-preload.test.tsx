import { describe, expect, spyOn, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { SurfaceErrorBoundary } from '../components/shell/SurfaceErrorBoundary';
import {
  createSurfacePreloader,
  isChunkLoadError,
  nextSurfaces,
  whenBrowserIdle,
} from '../lib/shell/surface-preload';

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

describe('a surface that does not load', () => {
  const failing = (error: Error) => {
    const Throws = (): null => {
      throw error;
    };
    return Throws;
  };

  async function render(error: Error, quiet = false) {
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    const Throws = failing(error);
    let view: ReactTestRenderer | undefined;
    await act(async () => {
      view = create(
        <SurfaceErrorBoundary surface="Calendar" quiet={quiet}>
          <Throws />
        </SurfaceErrorBoundary>,
      );
    });
    logged.mockRestore();
    return view!;
  }

  test('a failure of one surface does not stay on the next, and a thrown text still shows', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    const Throws = failing('plain text' as unknown as Error);
    const Fine = () => <p>Fine</p>;
    let view: ReactTestRenderer | undefined;
    await act(async () => {
      view = create(
        <SurfaceErrorBoundary surface="Calendar">
          <Throws />
        </SurfaceErrorBoundary>,
      );
    });
    expect(JSON.stringify(view?.toJSON())).toContain('plain text');
    await act(async () => {
      view?.update(
        <SurfaceErrorBoundary surface="Today">
          <Fine />
        </SurfaceErrorBoundary>,
      );
    });
    logged.mockRestore();
    expect(JSON.stringify(view?.toJSON())).toContain('Fine');
  });

  test('the chunk errors of the browsers read as a chunk error, and others do not', () => {
    const chunk = new Error('Loading chunk 12 failed');
    expect(isChunkLoadError(chunk)).toBe(true);
    expect(isChunkLoadError(Object.assign(new Error('x'), { name: 'ChunkLoadError' }))).toBe(true);
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: /a.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('Convex query failed'))).toBe(false);
    expect(isChunkLoadError('text')).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });

  test('an old chunk offers a new page load, not a retry that cannot work', async () => {
    const view = await render(new Error('Loading chunk 12 failed'));
    const text = JSON.stringify(view.toJSON());
    expect(text).toContain('did not load.');
    expect(text).toContain('Load the page again');
    expect(text).not.toContain('Try again');
    await act(async () => view.unmount());
  });

  test('a render error says what happened and offers a retry', async () => {
    const view = await render(new Error('Convex query failed'));
    const text = JSON.stringify(view.toJSON());
    expect(text).toContain('hit an error.');
    expect(text).toContain('Convex query failed');
    expect(text).toContain('Try again');
    await act(async () => view.unmount());
  });

  test('a small floating control goes away without a message', async () => {
    const view = await render(new Error('Loading chunk 12 failed'), true);
    expect(view.toJSON()).toBeNull();
    await act(async () => view.unmount());
  });
});
