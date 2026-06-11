'use client';

import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

// Cursor-following glow over the app's dot-grid texture: the same dot
// pattern, drawn in accent color, revealed through a soft radial mask that
// tracks the pointer. CSS-variable updates only — no React re-renders.
export function DotGridGlow({ className }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    let raf = 0;
    const onMove = (event: PointerEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        el.style.setProperty('--glow-x', `${event.clientX}px`);
        el.style.setProperty('--glow-y', `${event.clientY}px`);
        el.style.opacity = '1';
      });
    };
    const onLeave = () => {
      el.style.opacity = '0';
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
    };
  }, []);

  return (
    <div
      ref={ref}
      aria-hidden
      className={cn('dot-grid-glow pointer-events-none fixed inset-0 z-0 opacity-0', className)}
    />
  );
}
