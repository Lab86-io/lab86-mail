'use client';

import type { ToolShape } from '@/lib/ai/tool-shapes';
import { formatDue } from '@/lib/chat/shape-format';
import { cn } from '@/lib/utils';
import { ActionBar, Facts, ShapeShell } from './shape-shell';

export function TaskCard({ shape }: { shape: Extract<ToolShape, { kind: 'task' }> }) {
  const item = shape.item;
  return (
    <ShapeShell summary={shape.summary}>
      <div className="flex min-w-0 flex-col gap-1 px-3 py-2.5">
        <span
          className={cn(
            'font-display text-[13px] font-semibold leading-snug',
            item.completed && 'line-through text-[var(--color-text-faint)]',
          )}
        >
          {item.title}
        </span>
        {item.description ? (
          <p className="line-clamp-4 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
            {item.description}
          </p>
        ) : null}
        <div className="flex min-w-0 items-baseline gap-3 pt-0.5">
          <Facts
            items={[
              item.column,
              formatDue(item.dueIso),
              item.priority,
              item.labels?.length ? item.labels.join(', ') : undefined,
            ]}
            className="min-w-0 flex-1"
          />
          <ActionBar rowKey={item.cardId} actions={shape.actions.length ? shape.actions : item.actions} />
        </div>
      </div>
    </ShapeShell>
  );
}
