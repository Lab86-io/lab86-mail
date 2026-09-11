'use client';

import type { ToolShape } from '@/lib/ai/tool-shapes';
import { formatProgress } from '@/lib/chat/shape-format';
import { ActionBar, Facts, ShapeShell } from './shape-shell';

export function WorkCard({ shape }: { shape: Extract<ToolShape, { kind: 'work' }> }) {
  const item = shape.item;
  const progress = item.progress;
  const ratio = progress?.total ? Math.min(1, progress.done / progress.total) : 0;
  return (
    <ShapeShell summary={shape.summary}>
      <div className="flex min-w-0 flex-col gap-1 px-3 py-2.5">
        <span className="truncate font-display text-[13px] font-semibold leading-snug">{item.title}</span>
        <Facts items={[item.shape, item.horizon, item.status]} />
        {item.currentStep ? (
          <span className="truncate text-[12px] leading-snug text-[var(--color-text)]">
            Next: {item.currentStep}
          </span>
        ) : null}
        <div className="flex min-w-0 items-center gap-3 pt-0.5">
          {progress?.total ? (
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span
                aria-hidden
                className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--color-bg-subtle)]"
              >
                <span
                  className="block h-full rounded-full bg-[var(--color-accent-3)]"
                  style={{ width: `${ratio * 100}%` }}
                />
              </span>
              <span className="shrink-0 text-[11px] tabular-nums text-[var(--color-text-faint)]">
                {formatProgress(progress)}
              </span>
            </span>
          ) : (
            <span className="flex-1" />
          )}
          <ActionBar rowKey={item.workId} actions={shape.actions.length ? shape.actions : item.actions} />
        </div>
      </div>
    </ShapeShell>
  );
}
