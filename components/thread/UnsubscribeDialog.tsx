'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { toastWithUndo } from '@/components/inbox/mail-undo-toast';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { callTool } from '@/lib/api-client';
import {
  type UnsubscribeOptionsView,
  unsubscribeConfirmCopy,
  unsubscribeResultMessage,
} from '@/lib/mail/unsubscribe-copy';

export interface SenderTarget {
  account: string;
  threadId: string;
  /** The mailbox address, for "an email from …" in the confirmation. */
  mailbox?: string | null;
}

type BlockResult = { sender: string; archived: number; failed: number; operationId?: string };

/** Blocks the sender of a thread and offers Undo when the change was recorded. */
export async function blockSenderWithUndo(
  target: SenderTarget,
  options: { onDone?: () => void; onUndone?: () => void } = {},
) {
  const result = await callTool<BlockResult>(
    'block_sender',
    { account: target.account, threadId: target.threadId },
    {},
    undefined,
    { acceptFailedResult: true },
  );
  toastWithUndo(`Blocked ${result.sender}`, result.operationId, {
    description: result.archived
      ? `Their mail goes to Noise. ${result.archived} ${result.archived === 1 ? 'thread' : 'threads'} left the inbox.`
      : 'Their mail goes to Noise from now on.',
    onUndone: options.onUndone,
  });
  if (result.failed) toast.error(`${result.failed} of their threads could not be archived.`);
  options.onDone?.();
  return result;
}

/**
 * Asks before an unsubscribe. It reads how the sender takes requests, says
 * where the request goes, and runs it only after the user confirms.
 */
export function UnsubscribeDialog({
  target,
  open,
  onOpenChange,
  onDone,
}: {
  target: SenderTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** After an unsubscribe or a block, for example to close the thread. */
  onDone?: () => void;
}) {
  const options = useQuery({
    queryKey: ['unsubscribe-options', target?.account, target?.threadId],
    queryFn: async () =>
      callTool<UnsubscribeOptionsView>('get_unsubscribe_options', {
        account: target?.account,
        threadId: target?.threadId,
      }),
    enabled: open && Boolean(target),
    staleTime: 5 * 60_000,
    retry: 0,
  });
  const copy = options.data ? unsubscribeConfirmCopy(options.data, target?.mailbox) : null;

  const run = useMutation({
    mutationFn: async () => {
      if (!target || !copy || !options.data) throw new Error('Nothing to unsubscribe from.');
      if (copy.action === 'block')
        return { kind: 'block' as const, result: await blockSenderWithUndo(target) };
      if (copy.action === 'open_link') {
        if (options.data.url) window.open(options.data.url, '_blank', 'noopener,noreferrer');
        return { kind: 'link' as const };
      }
      const result = await callTool<{
        status: 'unsubscribed' | 'requested' | 'open_link';
        sender: string;
      }>('unsubscribe_sender', {
        account: target.account,
        threadId: target.threadId,
        method: options.data.method,
        confirmed: true,
      });
      return { kind: 'unsubscribe' as const, result };
    },
    onSuccess: (outcome) => {
      onOpenChange(false);
      if (outcome.kind === 'unsubscribe' && target) {
        toast.success(unsubscribeResultMessage(outcome.result), {
          description: 'Mail already sent can still arrive for a few days.',
          action: {
            label: 'Block sender',
            onClick: () => {
              void blockSenderWithUndo(target).catch((error: Error) =>
                toast.error(error.message || 'Could not block this sender.'),
              );
            },
          },
        });
      }
      if (outcome.kind !== 'link') onDone?.();
    },
    onError: (error: Error) => toast.error(error.message || 'The unsubscribe did not go through.'),
  });

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{copy?.title ?? 'Unsubscribe'}</AlertDialogTitle>
          <AlertDialogDescription>
            {options.isLoading
              ? 'Checking how this sender takes unsubscribe requests…'
              : options.error
                ? options.error instanceof Error
                  ? options.error.message
                  : 'Could not read the unsubscribe details for this sender.'
                : copy?.description}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={run.isPending}>Cancel</AlertDialogCancel>
          <Button
            type="button"
            variant={copy?.action === 'unsubscribe' ? 'destructive' : 'default'}
            disabled={!copy || run.isPending}
            onClick={() => run.mutate()}
          >
            {run.isPending ? 'Working…' : (copy?.confirmLabel ?? 'Unsubscribe')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
