'use client';

import { Component, type ReactNode } from 'react';
import { isChunkLoadError } from '@/lib/shell/surface-preload';

// A live-data surface must never take the whole shell down with it (a thrown
// Convex query error propagates as a render error). Catch, explain, offer retry.
// The code of a surface also loads on demand. After a release, an open tab can
// ask for a chunk that no longer exists, and only a new page load fixes that.
export class SurfaceErrorBoundary extends Component<
  { surface: string; children: ReactNode; quiet?: boolean },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  // A thrown value can be anything. The message below reads an Error.
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  // One instance can serve several surfaces at the same place in the tree. A
  // failure of one surface must not stay on the next.
  componentDidUpdate(previous: { surface: string }) {
    if (previous.surface !== this.props.surface && this.state.error) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    // A small floating control has no room for a message.
    if (this.props.quiet) return null;
    const stale = isChunkLoadError(this.state.error);
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-md rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-5 text-center">
          <p className="text-[14px] font-medium">
            {this.props.surface} {stale ? 'did not load.' : 'hit an error.'}
          </p>
          <p className="mt-1 text-[12.5px] text-[var(--color-text-muted)]">
            {stale ? 'The app has a new version.' : this.state.error.message.slice(0, 300)}
          </p>
          <button
            type="button"
            onClick={() => (stale ? window.location.reload() : this.setState({ error: null }))}
            className="mt-4 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-[12.5px] hover:bg-[var(--color-bg-subtle)]"
          >
            {stale ? 'Load the page again' : 'Try again'}
          </button>
        </div>
      </div>
    );
  }
}
