// Preloads the code of a surface before the reader opens it. Each surface is its
// own chunk, so the shell paints without the code of the surfaces it does not
// show. The loaders live in components/shell/surface-loaders.ts.

import type { PrimaryView } from '../shared/types';

export type SurfaceLoaders = Partial<Record<PrimaryView, () => Promise<unknown>>>;

/** The surfaces that a reader of `view` opens next most often. */
export function nextSurfaces(view: PrimaryView): PrimaryView[] {
  switch (view) {
    case 'today':
      return ['mail', 'albatrosses'];
    case 'mail':
      return ['today', 'albatrosses'];
    default:
      return ['today', 'mail'];
  }
}

/** Starts each surface's load once. A failed load can start again. */
export function createSurfacePreloader(loaders: SurfaceLoaders) {
  const started = new Set<PrimaryView>();
  return (view: PrimaryView) => {
    const load = loaders[view];
    if (!load || started.has(view)) return;
    started.add(view);
    void load().catch(() => {
      started.delete(view);
    });
  };
}

interface IdleWindow {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
  setTimeout: (callback: () => void, delay: number) => number;
  clearTimeout: (handle: number) => void;
  navigator?: { connection?: { saveData?: boolean } };
}

/** Runs `work` when the browser is idle. A data-saver connection skips it. Returns a cancel. */
export function whenBrowserIdle(work: () => void, target: IdleWindow = window as unknown as IdleWindow) {
  if (target.navigator?.connection?.saveData) return () => undefined;
  if (target.requestIdleCallback) {
    const handle = target.requestIdleCallback(work, { timeout: 4_000 });
    return () => target.cancelIdleCallback?.(handle);
  }
  const handle = target.setTimeout(work, 1_500);
  return () => target.clearTimeout(handle);
}

/** True for a failed load of on-demand code. After a release an open tab can ask for an old chunk. */
export function isChunkLoadError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error ?? '');
  return (
    name === 'ChunkLoadError' ||
    /loading (css )?chunk|failed to load chunk|dynamically imported module|importing a module script failed/i.test(
      message,
    )
  );
}
