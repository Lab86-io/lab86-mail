'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { toastWithUndo } from '@/components/inbox/mail-undo-toast';
import { type SenderTarget, UnsubscribeDialog } from '@/components/thread/UnsubscribeDialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { callTool } from '@/lib/api-client';
import type { SenderCleanupRow } from '@/lib/mail/sender-cleanup';
import { newCleanupBatchId, senderCleanupSummary } from '@/lib/mail/sender-cleanup-view';
import { formatDate } from '@/lib/shared/format';

/**
 * Sender cleanup (FEATURES item 13): the senders whose recent mail goes
 * unread or lands in Noise, with Unsubscribe on each row and a batch Block.
 * Blocks show in Activity with Undo; an unsubscribe asks first.
 */
export function SenderCleanup({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const senders = useQuery({
    queryKey: ['sender-cleanup'],
    queryFn: async () =>
      callTool<{ senders: SenderCleanupRow[]; scanned: number }>('list_sender_cleanup', { limit: 40 }),
    enabled: open,
    staleTime: 60_000,
  });
  const rows = senders.data?.senders || [];
  const [selected, setSelected] = useState<string[]>([]);
  const [unsubscribeTarget, setUnsubscribeTarget] = useState<SenderTarget | null>(null);
  const allSelected = rows.length > 0 && selected.length === rows.length;
  const selectedRows = useMemo(() => rows.filter((row) => selected.includes(row.sender)), [rows, selected]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['sender-cleanup'] });
    void queryClient.invalidateQueries({ queryKey: ['search'] });
  };

  const blockSelected = useMutation({
    mutationFn: async (targets: SenderCleanupRow[]) => {
      // One batch id: the blocks read as one change-set in Activity, and one
      // Undo here takes back the whole batch.
      const operationBatchId = newCleanupBatchId();
      const outcome = {
        blocked: [] as string[],
        failed: [] as string[],
        archived: 0,
        operationIds: [] as string[],
      };
      for (const row of targets) {
        try {
          const result = await callTool<{ archived: number; operationId?: string }>(
            'block_sender',
            { sender: row.sender, operationBatchId },
            {},
            undefined,
            { acceptFailedResult: true },
          );
          outcome.blocked.push(row.sender);
          outcome.archived += result.archived;
          if (result.operationId) outcome.operationIds.push(result.operationId);
        } catch {
          outcome.failed.push(row.sender);
        }
      }
      return outcome;
    },
    onSuccess: (outcome) => {
      setSelected([]);
      const summary = senderCleanupSummary(outcome);
      if (summary.success) toastWithUndo(summary.success, outcome.operationIds, { onUndone: refresh });
      if (summary.error) toast.error(summary.error);
      refresh();
    },
    onError: (error: Error) => toast.error(error.message || 'Could not block these senders.'),
  });

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[82vh] overflow-y-auto sm:max-w-xl">
          <DialogTitle>Sender cleanup</DialogTitle>
          <DialogDescription>
            Senders whose recent mail you leave unopened or that Albatross sorted as Noise or promotions.
            Unsubscribe from a list, or block a sender to send their mail to Noise and clear it from the
            inbox.
          </DialogDescription>
          {senders.isLoading ? (
            <p className="text-[13px] text-[var(--color-text-muted)]">Reading your recent mail…</p>
          ) : senders.error ? (
            <p className="text-[13px] text-[var(--color-danger)]">
              The sender list could not load. Try again.
            </p>
          ) : !rows.length ? (
            <p className="text-[13px] text-[var(--color-text-muted)]">
              No sender stands out. Recent mail you do not read will show here.
            </p>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3">
                <label
                  htmlFor="sender-cleanup-all"
                  className="flex items-center gap-2 text-[12px] text-[var(--color-text-muted)]"
                >
                  <Checkbox
                    id="sender-cleanup-all"
                    checked={allSelected}
                    onCheckedChange={(checked) => setSelected(checked ? rows.map((row) => row.sender) : [])}
                    aria-label="Select every sender"
                  />
                  {selected.length ? `${selected.length} selected` : 'Select all'}
                </label>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!selectedRows.length || blockSelected.isPending}
                  onClick={() => blockSelected.mutate(selectedRows)}
                >
                  {blockSelected.isPending
                    ? 'Blocking…'
                    : selectedRows.length > 1
                      ? `Block ${selectedRows.length} senders`
                      : 'Block sender'}
                </Button>
              </div>
              <ul className="divide-y divide-[var(--color-border)] rounded-ui border border-[var(--color-border)]">
                {rows.map((row) => (
                  <li key={row.sender} className="flex items-start gap-3 px-3 py-2.5">
                    <Checkbox
                      className="mt-0.5"
                      checked={selected.includes(row.sender)}
                      onCheckedChange={(checked) =>
                        setSelected((current) =>
                          checked
                            ? [...current, row.sender]
                            : current.filter((sender) => sender !== row.sender),
                        )
                      }
                      aria-label={`Select ${row.name}`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium">{row.name}</p>
                      <p className="truncate text-[11.5px] text-[var(--color-text-muted)]">
                        {row.sender} · last {formatDate(row.lastDate)}
                      </p>
                      <p className="truncate text-[11.5px] text-[var(--color-text-faint)]">{row.reason}</p>
                    </div>
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      className="shrink-0"
                      onClick={() =>
                        setUnsubscribeTarget({ account: row.latest.accountId, threadId: row.latest.threadId })
                      }
                    >
                      Unsubscribe
                    </Button>
                  </li>
                ))}
              </ul>
              <p className="text-[11.5px] text-[var(--color-text-faint)]">
                From your {senders.data?.scanned ?? 0} most recent threads.
              </p>
            </>
          )}
        </DialogContent>
      </Dialog>
      <UnsubscribeDialog
        target={unsubscribeTarget}
        open={Boolean(unsubscribeTarget)}
        onOpenChange={(value) => {
          if (!value) setUnsubscribeTarget(null);
        }}
        onDone={refresh}
      />
    </>
  );
}
