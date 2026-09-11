'use client';

import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

/** Keep punctuation and combining marks with the initial, and every source
 * character in reading order. Non-letter openings remain ordinary prose. */
export function splitInitial(text: string): [string, string] {
  const match = text.match(/^([\p{Pi}\p{Ps}"']*\p{L}\p{M}*)([\s\S]*)$/u);
  return match ? [match[1], match[2]] : ['', text];
}

/** Adobe measures the actual font and aligns the initial with the second
 * text baseline. CSS supplies a readable first paint while fonts load. */
export function DropCap({ text, className }: { text: string; className?: string }) {
  const [initial, rest] = splitInitial(text);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const cap = ref.current;
    if (!cap || !document.fonts || typeof ResizeObserver === 'undefined') return;
    let disposed = false;
    let resize: ResizeObserver | undefined;
    let layout: (() => void) | undefined;
    void Promise.all([import('dropcap.js'), document.fonts.ready]).then(() => {
      if (disposed) return;
      layout = () => {
        if (cap.isConnected && cap.parentElement?.clientWidth) window.Dropcap.layout(cap, 2);
      };
      layout();
      resize = new ResizeObserver(layout);
      if (cap.parentElement) resize.observe(cap.parentElement);
      document.fonts.addEventListener('loadingdone', layout);
    });
    return () => {
      disposed = true;
      resize?.disconnect();
      if (layout) document.fonts.removeEventListener('loadingdone', layout);
    };
  }, [initial]);

  return (
    <p data-narrative-lede className={cn('flow-root', className)}>
      {initial ? (
        <span key={initial} ref={ref} data-drop-cap className="editorial-initial">
          {initial}
        </span>
      ) : null}
      {rest}
    </p>
  );
}
