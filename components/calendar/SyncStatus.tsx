'use client';

import { type CalendarSyncError, syncStatusLine } from '@/lib/calendar/sync-copy';
import { cn } from '@/lib/utils';

// One muted sentence in the calendar header: "Synced 4 minutes ago". The
// sentence is the resync control. Click or Enter posts a manual resync.

export function SyncStatus({
  lastSyncedAt,
  syncing,
  error,
  nowMs,
  busy = false,
  onResync,
  className,
}: {
  lastSyncedAt: number | null;
  syncing: boolean;
  error: CalendarSyncError | null;
  nowMs: number;
  busy?: boolean;
  onResync: () => void;
  className?: string;
}) {
  const line = syncStatusLine({ lastSyncedAt, nowMs, syncing, error });
  const failed = error?.kind === 'failed';
  return (
    <button
      type="button"
      data-sync-status
      data-state={failed ? 'failed' : error ? 'limited' : syncing ? 'syncing' : 'idle'}
      onClick={onResync}
      disabled={busy}
      aria-live="polite"
      title="Sync now"
      className={cn(
        'rounded-sm text-[12px] leading-5 transition-colors duration-150 hover:text-[var(--color-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)] disabled:cursor-default',
        failed ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]',
        className,
      )}
    >
      {line}
    </button>
  );
}
