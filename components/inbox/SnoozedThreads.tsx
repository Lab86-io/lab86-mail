'use client';

import { useMutation } from '@tanstack/react-query';
import { useConvexAuth, useQuery_experimental as useConvexQuery } from 'convex/react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/convex/_generated/api';
import { callTool } from '@/lib/api-client';
import { type SnoozedThreadRow, snoozeReturnLabel, unsnoozeSnoozedThread } from '@/lib/mail/snoozed';
import { decodeMailText, shortFrom } from '@/lib/shared/format';

/** Snoozed threads across every connected mailbox, each with Unsnooze. */
export function SnoozedThreads({
  open,
  onOpenChange,
  onOpenThread,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenThread?: (row: SnoozedThreadRow) => void;
}) {
  // The list query requires an identity; skip it until Convex has one.
  const { isAuthenticated } = useConvexAuth();
  const snoozed = useConvexQuery({
    query: (api as any).mailCorpus.listSnoozedThreads,
    args: open && isAuthenticated ? {} : ('skip' as never),
  });
  // The live query drops the row when cancelSnooze runs, so no refetch here.
  const unsnooze = useMutation({
    mutationFn: (row: SnoozedThreadRow) => unsnoozeSnoozedThread(row, callTool),
    onSuccess: () => toast.success('Moved back to the inbox'),
    onError: (err: any) => toast.error(err?.message || 'Could not unsnooze this thread.'),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-lg">
        <DialogTitle>Snoozed</DialogTitle>
        <DialogDescription>
          Mail that comes back to the inbox later. Unsnooze a thread to bring it back now.
        </DialogDescription>
        <SnoozedThreadsList
          loading={snoozed.status !== 'success' && snoozed.status !== 'error'}
          error={snoozed.status === 'error'}
          rows={snoozed.status === 'success' ? snoozed.data?.items || [] : []}
          unsnoozing={unsnooze.isPending ? unsnooze.variables?.id : undefined}
          onUnsnooze={(row) => unsnooze.mutate(row)}
          onOpen={
            onOpenThread
              ? (row) => {
                  onOpenThread(row);
                  onOpenChange(false);
                }
              : undefined
          }
        />
      </DialogContent>
    </Dialog>
  );
}

export function SnoozedThreadsList({
  loading,
  error,
  rows,
  unsnoozing,
  onUnsnooze,
  onOpen,
  now,
}: {
  loading: boolean;
  error: boolean;
  rows: SnoozedThreadRow[];
  unsnoozing?: string;
  onUnsnooze: (row: SnoozedThreadRow) => void;
  onOpen?: (row: SnoozedThreadRow) => void;
  now?: Date;
}) {
  if (loading) return <p className="text-[13px] text-[var(--color-text-muted)]">Loading snoozed mail…</p>;
  if (error) return <p className="text-[13px] text-[var(--color-danger)]">Could not load snoozed mail.</p>;
  if (!rows.length) return <p className="text-[13px] text-[var(--color-text-muted)]">Nothing is snoozed.</p>;
  return (
    <ul className="divide-y divide-[var(--color-border)] rounded-ui border border-[var(--color-border)]">
      {rows.map((row) => {
        const sender = shortFrom(row.fromAddress) || 'Unknown sender';
        const snippet = decodeMailText(row.snippet);
        const details = (
          <>
            <p className="truncate text-[13px] font-medium">{row.subject}</p>
            <p className="truncate text-[11.5px] text-[var(--color-text-muted)]">
              {row.accountEmail ? `${sender} · ${row.accountEmail}` : sender}
            </p>
            {snippet ? (
              <p className="truncate text-[11.5px] text-[var(--color-text-faint)]">{snippet}</p>
            ) : null}
          </>
        );
        return (
          <li key={row.id} className="flex items-start gap-3 px-3 py-2.5">
            {onOpen ? (
              <button
                type="button"
                aria-label={`Open ${row.subject}`}
                className="min-w-0 flex-1 text-left"
                onClick={() => onOpen(row)}
              >
                {details}
              </button>
            ) : (
              <div className="min-w-0 flex-1">{details}</div>
            )}
            <div className="flex shrink-0 flex-col items-end gap-1.5">
              <p className="whitespace-nowrap text-[11.5px] tabular-nums text-[var(--color-text-muted)]">
                {snoozeReturnLabel(row.untilTs, now)}
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={unsnoozing === row.id}
                onClick={() => onUnsnooze(row)}
              >
                {unsnoozing === row.id ? 'Unsnoozing…' : 'Unsnooze'}
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
