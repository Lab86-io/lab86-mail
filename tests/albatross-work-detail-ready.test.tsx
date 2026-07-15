import { describe, expect, test } from 'bun:test';
import { createRef } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import {
  type ArtifactReadyHost,
  WorkDetailArtifactFrame,
} from '../components/albatross/WorkDetailArtifactFrame';

describe('WorkDetail artifact readiness', () => {
  test('reveals on fallback and cancels stale timers on artifact change and unmount', async () => {
    let nextTimer = 1;
    const scheduled = new Map<number, { callback: () => void; delay: number }>();
    const cancelled: number[] = [];
    const host: ArtifactReadyHost = {
      addEventListener: () => {},
      removeEventListener: () => {},
      setTimeout: (callback, delay) => {
        const handle = nextTimer++;
        scheduled.set(handle, { callback, delay });
        return handle;
      },
      clearTimeout: (handle) => {
        cancelled.push(handle);
        scheduled.delete(handle);
      },
    };
    const frameRef = createRef<HTMLIFrameElement>();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <WorkDetailArtifactFrame
          artifact="<html><body>First brief</body></html>"
          frameRef={frameRef}
          title="Brief for Work"
          onLoad={() => {}}
          host={host}
        />,
      );
    });

    let iframe = renderer.root.findByType('iframe');
    expect(iframe.props['aria-busy']).toBe(true);
    expect(iframe.props.className).toContain('opacity-0');
    const firstHandle = [...scheduled.keys()][0];
    expect(scheduled.get(firstHandle)?.delay).toBe(2_500);

    await act(async () => scheduled.get(firstHandle)?.callback());
    iframe = renderer.root.findByType('iframe');
    expect(iframe.props['aria-busy']).toBe(false);
    expect(iframe.props.className).toContain('opacity-100');

    await act(async () =>
      renderer.update(
        <WorkDetailArtifactFrame
          artifact="<html><body>Second brief</body></html>"
          frameRef={frameRef}
          title="Brief for Work"
          onLoad={() => {}}
          host={host}
        />,
      ),
    );
    expect(cancelled).toContain(firstHandle);
    iframe = renderer.root.findByType('iframe');
    expect(iframe.props['aria-busy']).toBe(true);
    const secondHandle = [...scheduled.keys()][0];

    await act(async () => renderer.unmount());
    expect(cancelled).toContain(secondHandle);
  });
});
