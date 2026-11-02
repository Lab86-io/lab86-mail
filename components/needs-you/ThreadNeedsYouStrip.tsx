'use client';

// The Needs you strip in the mail reader (docs/research/needs-you-web-2-design-2026-11-02.md).
// A thread with an open item shows one strip under the title bar: what the
// user owes, why, and Draft reply, Done, Later. The items come from the one
// snapshot subscription; no query runs for the thread.

import { useCallback, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useClientStore } from '@/lib/client-state';
import type { ObligationView } from '@/lib/obligations/contract';
import { type LaterOption, laterOptions } from '@/lib/obligations/groups';
import { canSendReply } from '@/lib/obligations/labels';
import { mailThreadKey, obligationsByThread, threadStripWords } from '@/lib/obligations/surfaces';
import { cn } from '@/lib/utils';
import { requestNeedsYouItem, useNeedsYouSnapshot } from './data';
import { NeedsYouGate } from './NeedsYouGate';
import { ObligationLead } from './NeedsYouRow';
import { useNowMs } from './useNeedsYou';
import { type ObligationPost, useObligationActions } from './useObligationActions';

export const THREAD_STRIP_COPY = {
  kicker: 'Needs you',
  draftReply: 'Draft reply',
  done: 'Done',
  later: 'Later',
  open: 'Open in Needs you',
} as const;

export interface ThreadNeedsYouStripProps {
  items: readonly ObligationView[];
  now: number;
  timezone: string;
  post?: ObligationPost;
  /** "Draft reply": the item opens on the page, where the prepared draft is. */
  onDraftReply: (obligation: ObligationView) => void;
  onOpen: (obligation: ObligationView) => void;
  className?: string;
}

/** The pure strip. Renders nothing without an open item. */
export function ThreadNeedsYouStrip({
  items,
  now,
  timezone,
  post,
  onDraftReply,
  onOpen,
  className,
}: ThreadNeedsYouStripProps) {
  const actions = useObligationActions({ post });
  const merged = useMemo(() => actions.merge(items), [actions, items]);
  const open = useMemo(() => {
    const map = obligationsByThread(merged, now);
    const first = map.values().next();
    return first.done ? [] : first.value;
  }, [merged, now]);
  const words = threadStripWords(open);
  const later = useMemo(() => laterOptions(now, timezone), [now, timezone]);
  if (!words) return null;
  const { lead, others } = words;
  const busy = actions.busyId === lead.id;
  const error = actions.error?.id === lead.id ? actions.error.text : null;
  const hot = lead.pushLevel === 'time_sensitive';
  return (
    <div
      data-thread-needs-you={lead.id}
      className={cn(
        'flex flex-wrap items-start gap-x-3 gap-y-1.5 border-b border-[var(--color-border)] bg-[var(--color-accent-soft)]/45 px-4 py-2.5',
        className,
      )}
    >
      <ObligationLead obligation={lead} size={24} className="mt-px" />
      <div className="min-w-[240px] flex-1">
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[13.5px] leading-[19px]">
          <span
            className={cn(
              'text-[11px] font-semibold',
              hot ? 'text-[var(--color-accent-2)]' : 'text-[var(--color-accent)]',
            )}
          >
            {THREAD_STRIP_COPY.kicker}
          </span>
          <span className="font-display font-medium text-[var(--color-text)]">{lead.title}</span>
          {others > 0 ? (
            <span className="text-[11.5px] text-[var(--color-text-muted)]">
              and {others} more in this thread
            </span>
          ) : null}
        </p>
        {lead.why ? (
          <p className="mt-0.5 text-[12px] leading-[17px] text-[var(--color-text-muted)]">{lead.why}</p>
        ) : null}
        {error ? (
          <p role="alert" className="mt-1 text-[12px] text-[var(--color-danger)]">
            {error}
          </p>
        ) : null}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {canSendReply(lead) ? (
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2.5 text-[12px]"
            disabled={busy}
            onClick={() => onDraftReply(lead)}
          >
            {THREAD_STRIP_COPY.draftReply}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2.5 text-[12px]"
            disabled={busy}
            onClick={() => onOpen(lead)}
          >
            {THREAD_STRIP_COPY.open}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2.5 text-[12px]"
          disabled={busy}
          onClick={() => void actions.act(lead, { action: 'done' })}
        >
          {THREAD_STRIP_COPY.done}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost" className="h-7 px-2.5 text-[12px]" disabled={busy}>
              {THREAD_STRIP_COPY.later}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {later.map((option: LaterOption) => (
              <DropdownMenuItem
                key={option.id}
                onSelect={() => void actions.act(lead, { action: 'later', until: option.until })}
              >
                {option.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function ConnectedStrip({ accountId, threadId }: { accountId: string; threadId: string }) {
  const snapshot = useNeedsYouSnapshot();
  const nowMs = useNowMs(60_000);
  const setPrimaryView = useClientStore((state) => state.setPrimaryView);
  const items = useMemo(() => {
    if (!snapshot?.enabled) return [];
    const key = mailThreadKey(accountId, threadId);
    return snapshot.items.filter(
      (item) => item.accountId && item.threadId && mailThreadKey(item.accountId, item.threadId) === key,
    );
  }, [snapshot, accountId, threadId]);
  const openItem = useCallback(
    (obligation: ObligationView) => {
      requestNeedsYouItem(obligation.id);
      setPrimaryView('notifications');
    },
    [setPrimaryView],
  );
  if (!snapshot?.enabled || !items.length) return null;
  return (
    <ThreadNeedsYouStrip
      items={items}
      now={nowMs}
      timezone={snapshot.timezone}
      onDraftReply={openItem}
      onOpen={openItem}
    />
  );
}

/** The strip for one thread, for users in LAB86_NEEDS_YOU. Nothing for anyone else. */
export function ThreadNeedsYou({
  accountId,
  threadId,
}: {
  accountId: string | null;
  threadId: string | null;
}) {
  if (!accountId || !threadId) return null;
  return (
    <NeedsYouGate fallback={null}>
      <ConnectedStrip accountId={accountId} threadId={threadId} />
    </NeedsYouGate>
  );
}

/**
 * The inbox list: one lookup from the snapshot, so each row reads a map and
 * no row starts a query. The value is the title of the first open item.
 */
export function useNeedsYouThreadMarks(): ReadonlyMap<string, string> {
  const snapshot = useNeedsYouSnapshot();
  const nowMs = useNowMs(60_000);
  return useMemo(() => {
    const marks = new Map<string, string>();
    if (!snapshot?.enabled) return marks;
    for (const [key, items] of obligationsByThread(snapshot.items, nowMs)) marks.set(key, items[0].title);
    return marks;
  }, [snapshot, nowMs]);
}
