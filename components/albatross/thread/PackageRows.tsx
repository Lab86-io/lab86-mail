'use client';

// The package a goal run hands over (docs/albatross-goal-runs.md G3): one
// row per item, hairlines between them, no card. Line 1 is the title and the
// kind word at the trailing edge; line 2 is the state in its voice and the
// note. The whole row is a button that opens the item: document mode on its
// tab, or the place of an approval, an event, or a page.

import type { RunSource } from '@/lib/albatross/goal-run-contract';
import type { PackageBehaviour, PackageRowView, SourceBehaviour } from '@/lib/albatross/goal-run-view';
import type { NextBehaviour } from '@/lib/albatross/step-run-client';
import type { ThreadRunView } from '@/lib/albatross/thread-contract';
import { cn } from '@/lib/utils';

/** The handlers a package row needs: the run block's props and the thread's handlers both fit. */
export interface PackageRowHandlers {
  onOpenItem?: (run: ThreadRunView, key: string) => void;
  onNext: (behaviour: NextBehaviour, run: ThreadRunView) => void;
  onOpenSource?: (behaviour: SourceBehaviour, source: RunSource, run: ThreadRunView) => void;
}

/**
 * What a package row opens: its tab in document mode, Notifications for an
 * approval, a new tab for a page, the calendar for an event. One dispatch for
 * the run block and the Details panel.
 */
export function openPackageBehaviour(
  behaviour: PackageBehaviour,
  run: ThreadRunView,
  handlers: PackageRowHandlers,
): void {
  switch (behaviour.kind) {
    case 'open_tab':
      handlers.onOpenItem?.(run, behaviour.key);
      return;
    case 'open_approval':
      handlers.onNext({ kind: 'open_approval', id: behaviour.id }, run);
      return;
    case 'open_url':
      handlers.onNext({ kind: 'open_url', url: behaviour.url }, run);
      return;
    case 'open_calendar':
      handlers.onOpenSource?.(
        { kind: 'open_calendar', id: behaviour.id },
        { kind: 'calendar', title: '', id: behaviour.id },
        run,
      );
      return;
    default:
      return;
  }
}

const TONE_CLASS: Record<PackageRowView['tone'], string> = {
  muted: 'text-[var(--color-text-muted)]',
  blank: 'text-[var(--color-accent-3)]',
  done: 'text-[var(--color-success)]',
};

export function PackageRows({
  rows,
  onOpen,
  className,
}: {
  rows: readonly PackageRowView[];
  onOpen?: (behaviour: PackageBehaviour, row: PackageRowView) => void;
  className?: string;
}) {
  if (!rows.length) return null;
  return (
    <ul
      data-slot="package-rows"
      className={cn(
        'divide-y divide-[var(--color-list-divider)] border-y border-[var(--color-list-divider)]',
        className,
      )}
    >
      {rows.map((row) => {
        const body = (
          <>
            <span className="min-w-0 truncate text-[13px] font-medium">{row.item.title}</span>
            <span className="shrink-0 self-baseline text-[11px] text-[var(--color-text-faint)]">
              {row.kindWord}
            </span>
            <span className="col-span-2 text-[12px] leading-[1.4]">
              <span className={cn('font-medium', TONE_CLASS[row.tone])}>{row.stateText}</span>
              {row.note ? <span className="text-[var(--color-text-muted)]"> {row.note}</span> : null}
            </span>
          </>
        );
        const layout = 'grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 py-2 text-left';
        const behaviour = row.behaviour;
        return (
          <li key={row.key} data-package-item={row.item.kind} data-package-state={row.item.state}>
            {behaviour && onOpen ? (
              <button
                type="button"
                onClick={() => onOpen(behaviour, row)}
                className={cn(
                  layout,
                  '-mx-2 w-[calc(100%+1rem)] rounded-ui px-2 hover:bg-[var(--color-hover-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--color-bg)]',
                )}
              >
                {body}
              </button>
            ) : (
              <div className={layout}>{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
