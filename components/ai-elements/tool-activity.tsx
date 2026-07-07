'use client';

// The one tool-activity treatment shared by every chat surface (Teach + the
// floating assistant): a quiet single-line sentence per tool call with exactly
// one indicator — the typing loader while running, nothing when done, danger
// text when failed. Never raw JSON, never a toast, never a bare tool name.
// Sentences come from toolActivityLine in lib/albatross/teach-ui.ts.

import { Loader } from '@/components/ui/loader';
import type { ToolActivity } from '@/lib/albatross/teach-ui';
import { cn } from '@/lib/utils';

export function ToolActivityRow({ activity, className }: { activity: ToolActivity; className?: string }) {
  return (
    <div
      className={cn(
        'flex items-center gap-1.5 px-1 text-[11.5px] leading-relaxed',
        activity.state === 'failed'
          ? 'text-[var(--color-danger)]'
          : activity.state === 'running'
            ? 'text-[var(--color-text-muted)]'
            : 'text-[var(--color-text-faint)]',
        className,
      )}
    >
      {activity.state === 'running' ? <Loader variant="typing" /> : null}
      <span className={cn('min-w-0 flex-1', activity.state === 'failed' ? 'break-words' : 'truncate')}>
        {activity.text}
      </span>
    </div>
  );
}
