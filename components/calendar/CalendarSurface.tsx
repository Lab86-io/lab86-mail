'use client';

import { CalendarDaysIcon } from '@/components/ui/calendar-days';

// M0 shell: the calendar surface mounts and owns its pane, but the grid,
// Nylas event sync, and editing land in M1 (see docs/productivity-platform-spec.md).
export function CalendarSurface() {
  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <header className="flex items-center gap-3 border-b border-[var(--color-border)] px-5 pb-4 pt-12 md:pt-5">
        <h1 className="font-display text-[20px] font-semibold tracking-tight text-[var(--color-text)]">
          Calendar
        </h1>
      </header>
      <div className="grid flex-1 place-items-center px-6">
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <span className="grid size-12 place-items-center rounded-full border border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[var(--color-text-muted)] shadow-[var(--shadow-soft)]">
            <CalendarDaysIcon size={22} />
          </span>
          <p className="font-display text-[16px] font-semibold text-[var(--color-text)]">
            Your calendars are on their way
          </p>
          <p className="text-[13px] leading-relaxed text-[var(--color-text-muted)]">
            Every connected account&apos;s calendar will sync here — fully editable, with the AI able to file
            events for you.
          </p>
        </div>
      </div>
    </div>
  );
}
