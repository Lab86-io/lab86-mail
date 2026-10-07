'use client';

// The page pane beside the conversation: the shared browser's live view, who
// has the page, and the one control that fits the moment (design note §5.3).
// "Take over" while Albatross has the page; the done label ("I paid") on the
// user's turn; "Close the page" to end the session. No "Check the page".

import { Button } from '@/components/ui/button';
import type { ThreadRunView } from '@/lib/albatross/thread-contract';
import { RUN_STATE_COPY } from '@/lib/albatross/thread-view';
import { cn } from '@/lib/utils';

export interface PageSession {
  sessionId: string;
  status: 'starting' | 'agent' | 'user' | 'verifying' | 'ended' | 'failed' | string;
  statusDetail?: string | null;
  liveViewUrl: string;
  stepKey?: string | null;
}

export type PagePaneDot = 'agent' | 'user' | 'paused' | 'checking' | 'opening' | 'closed' | 'error';

export interface PagePaneView {
  dot: PagePaneDot;
  /** The bold start of the line. */
  lead: string;
  /** The rest of the line. */
  detail: string | null;
  action:
    | { kind: 'take_over' }
    | { kind: 'done'; label: string }
    | { kind: 'reopen' }
    | { kind: 'retry' }
    | null;
  /** The session closes with "Close the page". */
  closes: boolean;
}

export const PAGE_PANE_COPY = {
  agentLead: 'Albatross is on the page.',
  pausedLead: 'Paused.',
  pausedDetail: 'Albatross continues after your answer.',
  userLead: 'Your turn.',
  checking: 'Checking the page…',
  opening: 'Opening a shared browser…',
  closed: 'The page is closed.',
  error: 'The page could not open.',
  takeOver: 'Take over',
  close: 'Close the page',
  reopen: 'Open the page again',
  tryAgain: 'Try again',
  title: 'Page',
} as const;

/** The pane's line and control from the session and the run that uses it. */
export function pagePaneView(session: PageSession | null, run: ThreadRunView | null): PagePaneView {
  if (!session || session.status === 'ended') {
    return {
      dot: 'closed',
      lead: PAGE_PANE_COPY.closed,
      detail: null,
      action: { kind: 'reopen' },
      closes: false,
    };
  }
  if (session.status === 'failed') {
    return {
      dot: 'error',
      lead: PAGE_PANE_COPY.error,
      detail: null,
      action: { kind: 'retry' },
      closes: false,
    };
  }
  if (session.status === 'starting') {
    return { dot: 'opening', lead: PAGE_PANE_COPY.opening, detail: null, action: null, closes: true };
  }
  if (session.status === 'verifying') {
    return { dot: 'checking', lead: PAGE_PANE_COPY.checking, detail: null, action: null, closes: false };
  }
  const open = run?.state === 'queued' || run?.state === 'running';
  if (session.status === 'agent') {
    return {
      dot: 'agent',
      lead: PAGE_PANE_COPY.agentLead,
      detail: session.statusDetail?.trim() || null,
      action: open ? { kind: 'take_over' } : null,
      closes: !open,
    };
  }
  // The session is the user's.
  if (run?.state === 'handed_off' && run.outcome === 'needs_answer') {
    return {
      dot: 'paused',
      lead: PAGE_PANE_COPY.pausedLead,
      detail: PAGE_PANE_COPY.pausedDetail,
      action: null,
      closes: true,
    };
  }
  const next = run?.state === 'handed_off' ? run.next : null;
  if (next && (next.kind === 'sign_in' || next.kind === 'finish_on_page')) {
    return {
      dot: 'user',
      lead: PAGE_PANE_COPY.userLead,
      detail: next.detail?.trim() || session.statusDetail?.trim() || null,
      action: { kind: 'done', label: next.doneLabel?.trim() || RUN_STATE_COPY.continueButton },
      closes: true,
    };
  }
  return {
    dot: 'user',
    lead: PAGE_PANE_COPY.userLead,
    detail: session.statusDetail?.trim() || null,
    action: null,
    closes: true,
  };
}

const DOT_CLASS: Record<PagePaneDot, string> = {
  agent: 'bg-[var(--color-accent)] shadow-[0_0_0_3px_var(--color-accent-soft)]',
  user: 'bg-[var(--color-success)] shadow-[0_0_0_3px_var(--color-success-soft)]',
  paused: 'bg-[var(--color-text-faint)]',
  checking: 'bg-[var(--color-accent)] animate-pulse',
  opening: 'bg-[var(--color-accent)]',
  closed: 'bg-[var(--color-border-strong)]',
  error: 'bg-[var(--color-danger)]',
};

export function PagePane({
  session,
  run,
  url,
  busy,
  onTakeOver,
  onDone,
  onClose,
  onReopen,
  className,
}: {
  session: PageSession | null;
  run: ThreadRunView | null;
  /** The step's site, for the address row. */
  url?: string | null;
  busy?: boolean;
  onTakeOver: () => void;
  onDone: () => void;
  onClose: () => void;
  onReopen?: () => void;
  className?: string;
}) {
  const view = pagePaneView(session, run);
  const live = session && session.status !== 'ended' && session.status !== 'failed';
  const host = hostOf(url);
  return (
    <aside
      data-slot="page-pane"
      data-page-state={view.dot}
      aria-label={host ? `Page: ${host}` : PAGE_PANE_COPY.title}
      className={cn('flex h-full min-h-0 min-w-0 flex-col bg-[var(--color-surface-well)]', className)}
    >
      <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-[var(--color-border)] bg-[var(--color-bg)] px-3.5">
        <span aria-hidden className={cn('size-2 shrink-0 rounded-full', DOT_CLASS[view.dot])} />
        <p className="min-w-0 flex-1 truncate text-[12.5px]" aria-live="polite">
          <span className="font-medium">{view.lead}</span>
          {view.detail ? <span className="text-[var(--color-text-muted)]"> {view.detail}</span> : null}
        </p>
        <span className="flex shrink-0 items-center gap-1.5">
          {view.action?.kind === 'take_over' ? (
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onTakeOver}>
              {busy ? 'Stopping…' : PAGE_PANE_COPY.takeOver}
            </Button>
          ) : null}
          {view.action?.kind === 'done' ? (
            <Button type="button" size="sm" disabled={busy} onClick={onDone}>
              {busy ? 'Continuing…' : view.action.label}
            </Button>
          ) : null}
          {view.action?.kind === 'reopen' && onReopen ? (
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onReopen}>
              {PAGE_PANE_COPY.reopen}
            </Button>
          ) : null}
          {view.action?.kind === 'retry' && onReopen ? (
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onReopen}>
              {PAGE_PANE_COPY.tryAgain}
            </Button>
          ) : null}
          {view.closes ? (
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onClose}>
              {PAGE_PANE_COPY.close}
            </Button>
          ) : null}
        </span>
      </div>
      {url ? (
        <div className="flex h-7 shrink-0 items-center border-b border-[var(--color-border)] bg-[var(--color-bg)] px-4 font-mono text-[11px] text-[var(--color-text-muted)]">
          <span className="truncate">{url.replace(/^https?:\/\//, '')}</span>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 p-3">
        {live ? (
          // The live view is the real browser, interactive. The user acts here;
          // Albatross reads the page state only to check the step.
          <iframe
            title="Shared browser"
            src={session.liveViewUrl}
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
            allow="clipboard-read; clipboard-write"
            className="h-full w-full rounded-ui border border-[var(--color-border)] bg-white"
          />
        ) : (
          <div className="grid h-full place-items-center rounded-ui border border-dashed border-[var(--color-border)] px-6 text-center">
            <p className="max-w-sm text-[13px] text-[var(--color-text-muted)]">{view.lead}</p>
          </div>
        )}
      </div>
    </aside>
  );
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
