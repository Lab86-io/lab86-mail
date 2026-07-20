'use client';

import { type RefObject, useEffect, useState } from 'react';
import {
  isBriefArtifactReadyMessage,
  scheduleBriefArtifactReadyFallback,
} from '@/lib/albatross/artifact-ready';
import { cn } from '@/lib/utils';

export interface ArtifactReadyHost {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(handle: number): void;
}

export function WorkDetailArtifactFrame({
  artifact,
  title,
  frameRef,
  onLoad,
  host,
}: {
  artifact: string;
  title: string;
  frameRef: RefObject<HTMLIFrameElement | null>;
  onLoad: () => void;
  host?: ArtifactReadyHost;
}) {
  const [ready, setReady] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new artifact must reset the reveal state.
  useEffect(() => setReady(false), [artifact]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new artifact must restart and cancel its own readiness handshake.
  useEffect(() => {
    const activeHost = (host ?? window) as ArtifactReadyHost;
    const onMessage = (event: MessageEvent) => {
      if (
        frameRef.current &&
        event.source === frameRef.current.contentWindow &&
        isBriefArtifactReadyMessage(event.data)
      ) {
        setReady(true);
      }
    };
    activeHost.addEventListener('message', onMessage);
    const cancelFallback = scheduleBriefArtifactReadyFallback(
      () => setReady(true),
      activeHost.setTimeout.bind(activeHost),
      activeHost.clearTimeout.bind(activeHost),
    );
    return () => {
      activeHost.removeEventListener('message', onMessage);
      cancelFallback();
    };
  }, [artifact, frameRef, host]);

  return (
    <iframe
      ref={frameRef}
      title={title}
      srcDoc={artifact}
      sandbox="allow-scripts allow-popups"
      onLoad={onLoad}
      aria-busy={!ready}
      className={cn(
        'min-h-[680px] w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]',
        ready ? 'opacity-100' : 'opacity-0',
      )}
    />
  );
}
