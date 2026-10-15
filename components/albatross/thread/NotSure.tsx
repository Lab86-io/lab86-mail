'use client';

// "Not sure": the things the user must check, from the run's `unsure` lines
// (docs/albatross-goal-runs.md G2). The label and the soft rule use the blank
// voice: these lines are the user's checks.

import { GOAL_RUN_COPY } from '@/lib/albatross/goal-run-view';
import { cn } from '@/lib/utils';

export function NotSure({ lines, className }: { lines: readonly string[]; className?: string }) {
  if (!lines.length) return null;
  return (
    <section
      data-slot="not-sure"
      aria-label={GOAL_RUN_COPY.notSure}
      className={cn('flex flex-col gap-1', className)}
    >
      <h3 className="text-[12px] font-medium text-[var(--color-accent-3)]">{GOAL_RUN_COPY.notSure}</h3>
      {lines.map((line) => (
        <p
          key={line}
          className="border-l-2 border-[var(--color-accent-3-soft)] pl-2.5 text-[12.5px] leading-[1.5] text-[var(--color-text)]"
        >
          {line}
        </p>
      ))}
    </section>
  );
}
