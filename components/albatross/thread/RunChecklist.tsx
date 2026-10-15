'use client';

// The checklist a goal run keeps (docs/albatross-goal-runs.md G1, lead
// review 2026-10-15). A list of rows with a narrow leading column: "Done" in
// the quiet success voice, the live dot for the item it works on now, "Yours"
// in the blank voice for a part only the user can do, and nothing for an open
// item. No check marks or circles: the user cannot tick an item. The run
// block folds it; the Details panel shows it open.

import { RevealDot } from '@/components/ai-elements/reveal-dot';
import { Task, TaskContent, TaskTrigger } from '@/components/ai-elements/task';
import type { ChecklistItem } from '@/lib/albatross/goal-run-contract';
import {
  CHECKLIST_STATE_NAME,
  CHECKLIST_STATE_WORD,
  checklistCount,
  GOAL_RUN_COPY,
} from '@/lib/albatross/goal-run-view';
import { cn } from '@/lib/utils';

export function ChecklistRows({ items, className }: { items: readonly ChecklistItem[]; className?: string }) {
  const count = checklistCount(items);
  return (
    <ul
      data-slot="checklist"
      aria-label={`${GOAL_RUN_COPY.checklist}, ${count.text} done`}
      className={cn('flex flex-col gap-1', className)}
    >
      {items.map((item) => {
        const word = CHECKLIST_STATE_WORD[item.state];
        return (
          <li
            key={item.id}
            data-checklist-state={item.state}
            className="grid grid-cols-[40px_minmax(0,1fr)] items-baseline gap-x-2 text-[12.5px] leading-[1.35]"
          >
            <span className="flex min-w-0 items-center" aria-hidden>
              {item.state === 'doing' ? (
                <RevealDot className="translate-y-[1px]" />
              ) : word ? (
                <span
                  className={cn(
                    'text-[11px] font-medium',
                    item.state === 'done' ? 'text-[var(--color-success)]' : 'text-[var(--color-accent-3)]',
                  )}
                >
                  {word}
                </span>
              ) : null}
            </span>
            <span
              className={cn(
                'min-w-0',
                item.state === 'done' && 'text-[var(--color-text-muted)]',
                item.state === 'doing' && 'font-medium',
              )}
            >
              {item.text}
              <span className="sr-only">, {CHECKLIST_STATE_NAME[item.state]}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** The checklist under a fold: "Checklist" with the count, open while the run works. */
export function RunChecklist({
  items,
  open,
  onOpenChange,
  className,
}: {
  items: readonly ChecklistItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  className?: string;
}) {
  if (!items.length) return null;
  const count = checklistCount(items);
  return (
    <Task open={open} onOpenChange={onOpenChange} className={cn('min-w-0', className)}>
      <TaskTrigger title={GOAL_RUN_COPY.checklist}>
        <button
          type="button"
          data-slot="checklist-trigger"
          className="group flex cursor-pointer items-center gap-1.5 text-left text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          <span>{GOAL_RUN_COPY.checklist}</span>
          <span className="tabular-nums text-[var(--color-text-faint)]">{count.text}</span>
          <span
            aria-hidden
            className="ml-0.5 inline-block size-[7px] -translate-y-[1px] rotate-[-45deg] border-r border-b border-current group-data-[state=open]:translate-y-[1px] group-data-[state=open]:rotate-45"
          />
        </button>
      </TaskTrigger>
      <TaskContent>
        <ChecklistRows items={items} />
      </TaskContent>
    </Task>
  );
}
