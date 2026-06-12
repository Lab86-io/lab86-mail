'use client';

import { SquareKanban } from 'lucide-react';

// M0 shell: the tasks surface mounts and owns its pane; boards, cards, and
// sharing land in M2 (see docs/productivity-platform-spec.md).
export function TasksSurface() {
  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <header className="flex items-center gap-3 border-b border-[var(--color-border)] px-5 pb-4 pt-12 md:pt-5">
        <h1 className="font-display text-[20px] font-semibold tracking-tight text-[var(--color-text)]">
          Tasks
        </h1>
      </header>
      <div className="grid flex-1 place-items-center px-6">
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <span className="grid size-12 place-items-center rounded-full border border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[var(--color-text-muted)] shadow-[var(--shadow-soft)]">
            <SquareKanban size={22} strokeWidth={1.75} />
          </span>
          <p className="font-display text-[16px] font-semibold text-[var(--color-text)]">Boards are coming</p>
          <p className="text-[13px] leading-relaxed text-[var(--color-text-muted)]">
            Kanban boards with rich cards, sharing, and an AI that files your to-dos straight from email.
          </p>
        </div>
      </div>
    </div>
  );
}
