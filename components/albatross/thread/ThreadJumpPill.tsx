'use client';

// The jump pill above the composer (lead review decision 12): "Newest" when
// the reader scrolled up; "Albatross needs an answer" when a pending form
// sits off screen. It renders inside the chat container, reads the
// container's own bottom state, and measures the form against the chat
// viewport on every scroll, so the label follows the reader.

import { useEffect, useState } from 'react';
import { useChatContainer } from '@/components/odysseyui/chat-container';
import { jumpPillLabel, PENDING_FORM_ATTRIBUTE, pendingFormVisibleIn } from '@/lib/albatross/thread-view';

export function ThreadJumpPill({ hasPendingForm }: { hasPendingForm: boolean }) {
  const { isAtBottom, scrollToBottom } = useChatContainer();
  const [formVisible, setFormVisible] = useState<boolean | null>(null);

  useEffect(() => {
    if (!hasPendingForm) {
      setFormVisible(null);
      return;
    }
    let frame = 0;
    let viewport: HTMLElement | null = null;
    const measure = () => {
      const target = document.querySelector<HTMLElement>(`[${PENDING_FORM_ATTRIBUTE}]`);
      const log = target?.closest<HTMLElement>('[role="log"]');
      viewport = log?.parentElement ?? null;
      if (!target || !viewport) {
        setFormVisible(null);
        return;
      }
      setFormVisible(pendingFormVisibleIn(viewport.getBoundingClientRect(), target.getBoundingClientRect()));
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    // The form may mount after the pill; look again on the next frames.
    schedule();
    const retry = window.setTimeout(schedule, 300);
    const log = document.querySelector<HTMLElement>('[data-thread-column]')?.closest('[role="log"]');
    const scroller = log?.parentElement;
    scroller?.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    const observer = log && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    if (log) observer?.observe(log);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(retry);
      scroller?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      observer?.disconnect();
    };
  }, [hasPendingForm]);

  const label = jumpPillLabel({ atBottom: isAtBottom, pendingFormVisible: formVisible });
  if (!label) return null;
  return (
    <div className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2">
      <button
        type="button"
        data-slot="thread-jump"
        onClick={() => {
          const target = document.querySelector(`[${PENDING_FORM_ATTRIBUTE}]`);
          if (formVisible === false && target) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
          else scrollToBottom('smooth');
        }}
        className="h-7 rounded-ui border border-[var(--color-border)] bg-[var(--color-surface-float)] px-3 text-[12px] font-medium text-[var(--color-text)] shadow-[var(--shadow-soft)] transition-colors hover:bg-[var(--color-control-hover)]"
      >
        {label}
      </button>
    </div>
  );
}
