'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { callTool } from '@/lib/api-client';
import { loadScheduledSends, type ScheduledSendRow } from '@/lib/shell/scheduled-sends';

type AccountsResult = { accounts: Array<{ accountId: string; email: string; authed: boolean }> };

/** Scheduled sends across every connected mailbox, each with Cancel. */
export function ScheduledSends({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const scheduled = useQuery({
    queryKey: ['scheduled-sends'],
    enabled: open,
    staleTime: 15_000,
    queryFn: async () => {
      const { accounts } = await callTool<AccountsResult>('list_accounts');
      return loadScheduledSends(
        accounts.filter((a) => a.authed).map((a) => ({ account: a.accountId, label: a.email })),
        (account) => callTool<{ scheduled: unknown[] }>('list_scheduled', { account }),
      );
    },
  });
  const cancel = useMutation({
    mutationFn: async (row: ScheduledSendRow) =>
      callTool('cancel_scheduled', { account: row.account, scheduleId: row.scheduleId }),
    onSuccess: () => {
      toast.success('Scheduled send cancelled');
      queryClient.invalidateQueries({ queryKey: ['scheduled-sends'] });
    },
    onError: (err: any) => toast.error(err?.message || 'Could not cancel this send.'),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-lg">
        <DialogTitle>Scheduled</DialogTitle>
        <DialogDescription>Mail that waits to send. Cancel a send to stop it.</DialogDescription>
        <ScheduledSendsList
          loading={scheduled.isLoading}
          error={scheduled.isError}
          rows={scheduled.data?.rows || []}
          failedAccounts={scheduled.data?.failedAccounts || []}
          cancelling={cancel.isPending ? cancel.variables?.scheduleId : undefined}
          onCancel={(row) => cancel.mutate(row)}
        />
      </DialogContent>
    </Dialog>
  );
}

export function ScheduledSendsList({
  loading,
  error,
  rows,
  failedAccounts,
  cancelling,
  onCancel,
}: {
  loading: boolean;
  error: boolean;
  rows: ScheduledSendRow[];
  failedAccounts: string[];
  cancelling?: string;
  onCancel: (row: ScheduledSendRow) => void;
}) {
  if (loading) return <p className="text-[13px] text-[var(--color-text-muted)]">Loading scheduled sends…</p>;
  if (error) return <p className="text-[13px] text-[var(--color-danger)]">Could not load scheduled sends.</p>;
  return (
    <div className="space-y-2">
      {rows.length ? (
        <ul className="divide-y divide-[var(--color-border)] rounded-ui border border-[var(--color-border)]">
          {rows.map((row) => (
            <li key={`${row.account}:${row.scheduleId}`} className="flex items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">
                  {row.at ? `Sends ${new Date(row.at).toLocaleString()}` : 'Waits to send'}
                </p>
                <p className="truncate text-[11.5px] text-[var(--color-text-muted)]">{row.accountLabel}</p>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={cancelling === row.scheduleId}
                onClick={() => onCancel(row)}
              >
                {cancelling === row.scheduleId ? 'Cancelling…' : 'Cancel send'}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-[var(--color-text-muted)]">Nothing is scheduled.</p>
      )}
      {failedAccounts.length ? (
        <p className="text-[12px] text-[var(--color-text-muted)]">
          Could not read scheduled sends for {failedAccounts.join(', ')}.
        </p>
      ) : null}
    </div>
  );
}
