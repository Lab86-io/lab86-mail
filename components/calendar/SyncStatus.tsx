'use client';

import { Check, CircleAlert, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { type CalendarSyncError, syncStatusLine } from '@/lib/calendar/sync-copy';
import { cn } from '@/lib/utils';

/** Quiet inline status; the same control can request a fresh sync. */
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
  const active = syncing || busy;
  const line =
    !active && !error && lastSyncedAt === null
      ? 'Waiting for the first calendar sync'
      : syncStatusLine({ lastSyncedAt, nowMs, syncing: active, error });
  const label = active ? line : `${line} · Sync now`;
  const Icon = active ? Loader2 : error ? CircleAlert : Check;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          data-sync-status
          data-state={active ? 'syncing' : error?.kind === 'failed' ? 'failed' : error ? 'limited' : 'idle'}
          onClick={() => {
            if (!active) onResync();
          }}
          aria-disabled={active}
          aria-label={label}
          title={label}
          className={cn(
            error
              ? 'text-[var(--color-danger)]'
              : lastSyncedAt
                ? 'text-[var(--color-accent)]'
                : 'text-[var(--color-text-faint)]',
            className,
          )}
        >
          <Icon aria-hidden className={cn('size-4', active && 'animate-spin motion-reduce:animate-none')} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
