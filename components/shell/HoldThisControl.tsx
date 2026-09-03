'use client';

import { useRef, useState } from 'react';
import { HOLD_ERROR, type HoldInput, type HoldResult, holdText } from '@/lib/albatross/capture-client';
import { cn } from '@/lib/utils';

// "Hold this" under an assistant reply. One click posts the reply and the
// user's message as one capture. The control then reads "Kept". A second
// click does nothing: the server keeps one Work per reply.

export type HoldThisState = 'idle' | 'pending' | 'kept' | 'error';

export interface HoldThisControlProps {
  messageId: string;
  conversationId: string;
  /** The user's message that the reply answers. */
  userText: string;
  replyText: string;
  hold?: (input: HoldInput) => Promise<HoldResult>;
  onKept?: (result: HoldResult) => void;
  className?: string;
}

export const HOLD_THIS_LABEL = 'Hold this';
export const HOLD_THIS_KEPT = 'Kept';

export function HoldThisControl({
  messageId,
  conversationId,
  userText,
  replyText,
  hold = holdText,
  onKept,
  className,
}: HoldThisControlProps) {
  const [state, setState] = useState<HoldThisState>('idle');
  const inFlight = useRef(false);

  const run = async () => {
    if (inFlight.current || state === 'kept' || state === 'pending') return;
    inFlight.current = true;
    setState('pending');
    try {
      const result = await hold({
        text: userText.trim() || replyText.trim(),
        replyText,
        conversationId,
        sourceMessageId: messageId,
      });
      setState('kept');
      onKept?.(result);
    } catch {
      setState('error');
    } finally {
      inFlight.current = false;
    }
  };

  const kept = state === 'kept';
  return (
    <div className={cn('flex items-center gap-2 text-[11.5px]', className)}>
      <button
        type="button"
        data-hold-this={messageId}
        data-state={state}
        onClick={() => void run()}
        disabled={kept}
        aria-disabled={kept || undefined}
        className={cn(
          'rounded px-1 py-0.5 font-medium transition-colors duration-[var(--duration-fast)]',
          kept
            ? 'cursor-default text-[var(--color-accent-2)]'
            : 'text-[var(--color-text-muted)] hover:text-[var(--color-accent-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-2)]/40',
          state === 'pending' && 'opacity-70',
        )}
      >
        {kept ? HOLD_THIS_KEPT : HOLD_THIS_LABEL}
      </button>
      {state === 'error' ? <span className="text-[var(--color-danger)]">{HOLD_ERROR}</span> : null}
    </div>
  );
}
