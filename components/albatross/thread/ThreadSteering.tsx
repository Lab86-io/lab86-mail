'use client';

// Steering in the thread (docs/albatross-threads.md, T5, T7–T9; lead
// decisions 5, 6, 8): the route line above the composer while a run works
// (context only: the route chip at the right of the bar is the one control,
// Run → Ask → Hold with Tab), the receipt under a sent note, and the
// placeholder for a reply that still runs on the server. Small, pure in their
// props, so the chat mounts them and the tests render them alone.

import { MessageBubble, MessageBubbleContent } from '@/components/odysseyui/message-bubble';
import { ShimmerText } from '@/components/odysseyui/text-shimmer';
import { NOTE_RECEIPT_COPY, type NoteReceipt } from '@/lib/albatross/thread-notes';
import { cn } from '@/lib/utils';

export const THREAD_ROUTE_COPY = {
  toRun: 'To the run',
  toAlbatross: 'To Albatross',
  runKeepsGoing: 'The run keeps going',
  stopAndRedirect: 'Stop and redirect',
  redirectArmed: 'The run stopped. Send what Albatross should do instead.',
  cancel: 'Cancel',
  runPlaceholder: 'Tell the run what to change',
  redirectPlaceholder: 'What should Albatross do instead?',
  replyInProgress: 'Reply in progress',
} as const;

/** What the composer does with the next message. */
export type ThreadComposerMode = 'run' | 'redirect' | 'ask';

export interface ThreadSteerRun {
  id: string;
  stepTitle: string;
  stepNumber: number | null;
}

/** "Step 2, Renew online"; "Renew online" when the step has no number. */
export function steerRunLabel(run: Pick<ThreadSteerRun, 'stepTitle' | 'stepNumber'>): string {
  return run.stepNumber ? `Step ${run.stepNumber}, ${run.stepTitle}` : run.stepTitle;
}

/** The placeholder the mode sets; null leaves the thread's own placeholder. */
export function threadComposerPlaceholder(mode: ThreadComposerMode): string | null {
  if (mode === 'run') return THREAD_ROUTE_COPY.runPlaceholder;
  if (mode === 'redirect') return THREAD_ROUTE_COPY.redirectPlaceholder;
  return null;
}

/**
 * The mode from the state: a redirect armed, else the run route unless the
 * chip stands on Ask or Hold (`askInstead`).
 */
export function threadComposerMode(input: {
  run: ThreadSteerRun | null;
  askInstead: boolean;
  redirectRunId: string | null;
}): ThreadComposerMode {
  if (input.redirectRunId) return 'redirect';
  if (input.run && !input.askInstead) return 'run';
  return 'ask';
}

/** Context above the field: where the next message goes. The chip in the bar changes it. */
export function ThreadRouteLine({
  mode,
  run,
  busy = false,
  onStopAndRedirect,
  onCancelRedirect,
}: {
  mode: ThreadComposerMode;
  run: ThreadSteerRun | null;
  busy?: boolean;
  onStopAndRedirect: () => void;
  onCancelRedirect: () => void;
}) {
  const link =
    'text-[12px] text-[var(--color-text-muted)] underline-offset-2 hover:text-[var(--color-text)] hover:underline';
  if (mode === 'redirect') {
    return (
      <div data-thread-route="redirect" className="flex items-center gap-2 px-1 pb-2 pt-1 text-[12px]">
        <span className="font-medium text-[var(--color-accent-2)]">{THREAD_ROUTE_COPY.stopAndRedirect}</span>
        <span className="text-[var(--color-text-faint)]">·</span>
        <span className="min-w-0 truncate text-[var(--color-text-muted)]">
          {THREAD_ROUTE_COPY.redirectArmed}
        </span>
        <button type="button" onClick={onCancelRedirect} className={cn('ml-auto shrink-0', link)}>
          {THREAD_ROUTE_COPY.cancel}
        </button>
      </div>
    );
  }
  if (!run) return null;
  if (mode === 'ask') {
    return (
      <div data-thread-route="ask" className="flex items-center gap-2 px-1 pb-2 pt-1 text-[12px]">
        <span className="font-medium text-[var(--color-text-muted)]">{THREAD_ROUTE_COPY.toAlbatross}</span>
        <span className="text-[var(--color-text-faint)]">·</span>
        <span className="min-w-0 truncate text-[var(--color-text-muted)]">
          {THREAD_ROUTE_COPY.runKeepsGoing}
        </span>
      </div>
    );
  }
  return (
    <div data-thread-route="run" className="flex items-center gap-2 px-1 pb-2 pt-1 text-[12px]">
      <span className="font-medium text-[var(--color-accent-2)]">{THREAD_ROUTE_COPY.toRun}</span>
      <span className="text-[var(--color-text-faint)]">·</span>
      <span className="min-w-0 truncate text-[var(--color-text-muted)]">{steerRunLabel(run)}</span>
      <button
        type="button"
        disabled={busy}
        onClick={onStopAndRedirect}
        className="ml-auto h-6 shrink-0 rounded-ui border border-[var(--color-border)] px-2 text-[12px] font-medium text-[var(--color-text-muted)] hover:bg-[var(--color-control-hover)] hover:text-[var(--color-text)] disabled:opacity-50"
      >
        {THREAD_ROUTE_COPY.stopAndRedirect}
      </button>
    </div>
  );
}

/** The one line under a sent note. */
export function NoteReceiptLine({
  receipt,
  onSendAgain,
}: {
  receipt: NoteReceipt;
  onSendAgain?: () => void;
}) {
  const tone =
    receipt.kind === 'failed'
      ? 'text-[var(--color-danger)]'
      : receipt.kind === 'not_read'
        ? 'text-[var(--color-warning)]'
        : receipt.kind === 'sent'
          ? 'text-[var(--color-text-faint)]'
          : 'text-[var(--color-text-muted)]';
  return (
    <p
      data-note-receipt={receipt.kind}
      className={cn('-mt-2 flex justify-end gap-2 pr-1 text-[11.5px]', tone)}
    >
      <span>{receipt.line}</span>
      {receipt.sendAgain && onSendAgain ? (
        <button
          type="button"
          onClick={onSendAgain}
          className="font-medium text-[var(--color-accent)] underline-offset-2 hover:underline"
        >
          {NOTE_RECEIPT_COPY.sendAgain}
        </button>
      ) : null}
    </p>
  );
}

/** A reply that still runs on the server (T5): the saved reply replaces this when it arrives. */
export function ReplyInProgressBubble({ onStop }: { onStop?: () => void }) {
  return (
    <MessageBubble from="assistant" data-reply-in-progress>
      <MessageBubbleContent className="flex items-center gap-3 bg-transparent px-0 py-0 text-[12.5px] text-[var(--color-text-muted)]">
        <span role="status">
          <ShimmerText text={THREAD_ROUTE_COPY.replyInProgress} duration={1.6} startOnView={false} />
        </span>
        {onStop ? (
          <button
            type="button"
            onClick={onStop}
            className="text-[12px] text-[var(--color-text-muted)] underline-offset-2 hover:text-[var(--color-text)] hover:underline"
          >
            Stop
          </button>
        ) : null}
      </MessageBubbleContent>
    </MessageBubble>
  );
}
