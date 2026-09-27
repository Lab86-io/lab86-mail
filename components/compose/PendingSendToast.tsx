'use client';

import { Send, Undo2 } from 'lucide-react';
import type { DurablePendingSend } from './PendingSendProvider';

export function PendingSendToast({
  record,
  now,
  cancelling,
  onUndo,
  onRestore,
}: {
  record: DurablePendingSend;
  now: number;
  cancelling: boolean;
  onUndo: () => void;
  onRestore: () => void;
}) {
  const remaining = Math.max(0, record.fireAt - now);
  const seconds = Math.ceil(remaining / 1_000);
  const preparing = record.status === 'preparing';
  const canUndo =
    preparing ||
    ((record.status === 'pending' || record.status === 'unknown') &&
      (seconds > 0 || record.id.startsWith('outbox:')));
  const recoverable = record.status === 'failed' || record.status === 'cancelled';
  const progress = Math.min(1, remaining / Math.max(1, record.undoSeconds * 1_000));
  const label = cancelling
    ? 'Cancelling send…'
    : preparing
      ? 'Preparing send…'
      : canUndo
        ? 'Ready to send'
        : recoverable
          ? record.status === 'failed'
            ? 'Send failed'
            : 'Send cancelled'
          : 'Confirming send…';

  return (
    <section
      aria-label={`Send status: ${record.draft.subject || 'Message'}`}
      className="pointer-events-auto flex items-center gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-3 shadow-xl"
    >
      <div className="relative grid size-10 shrink-0 place-items-center text-[var(--color-accent)]">
        {canUndo ? (
          <>
            <svg viewBox="0 0 40 40" className="absolute inset-0 size-10 -rotate-90" aria-hidden="true">
              <circle
                cx="20"
                cy="20"
                r="17"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                opacity="0.15"
              />
              <circle
                cx="20"
                cy="20"
                r="17"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                pathLength="1"
                strokeDasharray="1"
                strokeDashoffset={1 - progress}
                strokeLinecap="round"
              />
            </svg>
            <span
              role="timer"
              aria-label={`Sending in ${seconds} seconds`}
              className="font-mono text-[11px] font-medium tabular-nums"
            >
              {seconds >= 60
                ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
                : `${seconds}s`}
            </span>
          </>
        ) : recoverable ? (
          <Undo2 className="size-4" aria-hidden="true" />
        ) : (
          <Send className="size-4" aria-hidden="true" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p role="status" className="text-[12.5px] font-medium text-[var(--color-text)]">
          {label}
        </p>
        <p className="truncate text-[11px] text-[var(--color-text-muted)]" title={record.draft.subject}>
          {record.draft.subject || record.draft.to || 'Your message'}
        </p>
      </div>
      {canUndo || cancelling ? (
        <button
          type="button"
          disabled={cancelling}
          onClick={onUndo}
          className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-[var(--color-control-border)] bg-[var(--color-control)] px-3 text-[12px] font-medium text-[var(--color-text)] shadow-[var(--shadow-control)] hover:bg-[var(--color-control-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)] disabled:opacity-60"
        >
          {cancelling ? 'Undoing…' : 'Undo send'}
        </button>
      ) : recoverable ? (
        <button
          type="button"
          onClick={onRestore}
          className="h-9 shrink-0 rounded-lg border border-[var(--color-control-border)] px-3 text-[12px] font-medium text-[var(--color-text)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
        >
          Restore draft
        </button>
      ) : null}
    </section>
  );
}
