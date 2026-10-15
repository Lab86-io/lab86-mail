'use client';

// The draft tab of document mode (docs/research/goal-runs-web-design-2026-10-15.md,
// §5.3, §6): the composer in the center with the saved draft and its
// attachments as rows. The draft comes from `list_drafts` (the same read as
// openSavedDraft), so the composer updates it in place and sends it with the
// files the run attached.

import { useQuery } from '@tanstack/react-query';
import { InlineComposer } from '@/components/thread/InlineComposer';
import type { AllowSendFn } from '@/components/thread/use-allow-send';
import { GOAL_RUN_COPY } from '@/lib/albatross/goal-run-view';
import { callTool } from '@/lib/api-client';
import type { Draft } from '@/lib/shared/types';
import { cn } from '@/lib/utils';

export const DRAFTS_QUERY_KEY = (account: string) => ['drafts', account] as const;

export function DraftPane({
  draftId,
  accountId,
  allowSend,
  onSent,
  className,
}: {
  draftId: string;
  accountId: string | null;
  /** The send permission of a sealed file, through the identity check. The harness passes none. */
  allowSend?: AllowSendFn;
  /** The mail went out: the package row and the tab say "Sent". */
  onSent?: (draftId: string) => void;
  className?: string;
}) {
  const drafts = useQuery({
    queryKey: DRAFTS_QUERY_KEY(accountId ?? ''),
    enabled: Boolean(accountId),
    queryFn: async () => {
      const result = (await callTool('list_drafts', { account: accountId })) as { drafts?: Draft[] };
      return result?.drafts ?? [];
    },
  });
  const draft = drafts.data?.find((row) => row._id === draftId) ?? null;
  return (
    <section
      data-slot="draft-pane"
      aria-label={draft?.subject || 'Draft'}
      className={cn(
        'flex h-full min-h-0 min-w-0 flex-col overflow-y-auto bg-[var(--color-surface-well)] p-5',
        className,
      )}
    >
      {!accountId || drafts.isError || (drafts.isSuccess && !draft) ? (
        <p className="text-[12.5px] text-[var(--color-text-muted)]">{GOAL_RUN_COPY.draftGone}</p>
      ) : !draft ? (
        <p className="text-[12.5px] text-[var(--color-text-muted)]">{GOAL_RUN_COPY.draftLoading}</p>
      ) : (
        <div className="mx-auto w-full max-w-[760px]">
          <InlineComposer
            key={draft._id}
            mode="new"
            host="thread"
            account={draft.account}
            threadId={draft.threadId || null}
            anchorMessageId={draft.inReplyToMessageId || null}
            initialPrefill={{
              to: draft.to,
              cc: draft.cc,
              bcc: draft.bcc,
              subject: draft.subject,
              body: draft.body,
              draftId: draft._id,
              attachments: draft.attachments ?? [],
            }}
            allowSend={allowSend}
            onSent={() => onSent?.(draftId)}
          />
        </div>
      )}
    </section>
  );
}
