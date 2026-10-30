'use client';

import { Component, type ReactNode } from 'react';

/**
 * The Needs you query is new. When a deployment does not serve it yet, or it
 * fails, the surfaces inside this gate show their fallback: the view the user
 * had before. Nothing else on the page is affected.
 */
export class NeedsYouGate extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
