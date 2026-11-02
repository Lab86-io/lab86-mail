'use client';

// Approve and Decline for one queued approval. Each surface renders this one
// control: the hover pills of a list row, or the line and the pills of a detail
// and a thread block. The state lives by approval id, so all of them agree.

import { type ReactNode, useEffect, useRef } from 'react';
import { ShimmerText } from '@/components/odysseyui/text-shimmer';
import {
  APPROVAL_COPY,
  type ApprovalChoice,
  type ApprovalRef,
  type ApprovalView,
  approvalView,
  decideApproval,
  retainDecidedApprovals,
  useApprovalDecisions,
} from '@/lib/albatross/approval-decision';
import { cn } from '@/lib/utils';

/** The live state of one approval. Undefined for a row that is not an approval. */
export function useApprovalView(approval: ApprovalRef | undefined): ApprovalView | undefined {
  const local = useApprovalDecisions((state) => (approval ? state.decisions[approval.id] : undefined));
  return approval ? approvalView(approval, local) : undefined;
}

/** The items of a list, with the rows the user just decided still in place. */
export function useRetainedApprovals<T extends { id: string; approval?: { id: string } }>(
  items: readonly T[],
  now: number,
): readonly T[] {
  const decisions = useApprovalDecisions((state) => state.decisions);
  const seen = useRef(new Map<string, T>());
  useEffect(() => {
    for (const item of items) if (item.approval) seen.current.set(item.id, item);
  }, [items]);
  return retainDecidedApprovals(items, seen.current, decisions, now);
}

const SIZE_CLASS = {
  // The hover pills of a row: the same box as the other pills of NeedsYouRow.
  row: 'h-[22px] rounded-[8px] px-2 text-[12px] leading-5',
  // A touch target on a phone, and the row's type on a wider screen.
  block: 'h-11 rounded-ui px-4 text-[13px] sm:h-8 sm:rounded-[9px] sm:px-3 sm:text-[12.5px]',
} as const;

function Pill({
  label,
  primary,
  size,
  onPress,
}: {
  label: string;
  primary?: boolean;
  size: keyof typeof SIZE_CLASS;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      tabIndex={size === 'row' ? -1 : undefined}
      onClick={(event) => {
        event.stopPropagation();
        onPress();
      }}
      className={cn(
        'whitespace-nowrap border bg-[var(--color-bg-elevated)] font-medium transition-colors hover:bg-[var(--color-control-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-ring)]',
        SIZE_CLASS[size],
        primary
          ? 'border-[color-mix(in_oklab,var(--color-accent)_40%,var(--color-border))] text-[var(--color-accent)]'
          : 'border-[var(--color-border)] text-[var(--color-text-muted)]',
      )}
    >
      {label}
    </button>
  );
}

export function ApprovalDecisionPills({
  approval,
  size,
  className,
}: {
  approval: ApprovalRef;
  size: keyof typeof SIZE_CLASS;
  className?: string;
}) {
  const decide = (choice: ApprovalChoice) => void decideApproval(approval, choice);
  return (
    <span className={cn('gap-1.5', size === 'block' && 'flex flex-wrap gap-2', className)}>
      <Pill label={APPROVAL_COPY.approve} primary size={size} onPress={() => decide('approve')} />
      <Pill label={APPROVAL_COPY.decline} size={size} onPress={() => decide('decline')} />
    </span>
  );
}

// The accent palettes can put a green near the page color, so an outcome line stays in the text color.
const LINE_TONE = {
  plain: 'text-[var(--color-text-muted)]',
  hot: 'text-[var(--color-danger)]',
  done: 'font-medium text-[var(--color-text)]',
} as const;

/**
 * The line of what happened, then the pills while a press can reach the
 * server. `note` shows only until the decision. `end` is a quiet link.
 */
export function ApprovalDecision({
  approval,
  className,
  note,
  end,
}: {
  approval: ApprovalRef;
  className?: string;
  note?: string;
  end?: ReactNode;
}) {
  const view = approvalView(
    approval,
    useApprovalDecisions((state) => state.decisions[approval.id]),
  );
  const noteText = note && view.canDecide ? note : null;
  return (
    <div
      data-approval-decision={approval.id}
      data-approval-state={view.state}
      className={cn('flex flex-col gap-2', className)}
    >
      {view.line ? (
        <p
          role={view.state === 'failed' ? 'alert' : 'status'}
          className={cn('text-[12.5px] leading-[1.45]', LINE_TONE[view.tone])}
        >
          {view.state === 'deciding' ? (
            <ShimmerText text={view.line} duration={1.6} startOnView={false} />
          ) : (
            view.line
          )}
        </p>
      ) : null}
      {view.canDecide ? <ApprovalDecisionPills approval={approval} size="block" /> : null}
      {noteText || end ? (
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          {noteText ? <p className="text-[12px] text-[var(--color-text-faint)]">{noteText}</p> : <span />}
          {end}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The thread's answer to "open this approval": the control is on the page, so
 * focus moves to it and the user stays. False when no control is in view.
 */
export function focusApprovalControl(id: string | null): boolean {
  if (!id || typeof document === 'undefined') return false;
  const control = document.querySelector<HTMLElement>(`[data-approval-decision="${CSS.escape(id)}"]`);
  if (!control) return false;
  control.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  control.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  return true;
}
