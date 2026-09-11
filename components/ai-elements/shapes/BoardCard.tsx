'use client';

import type { ToolShape } from '@/lib/ai/tool-shapes';
import { ActionBar, ShapeShell } from './shape-shell';

export function BoardCard({ shape }: { shape: Extract<ToolShape, { kind: 'board' }> }) {
  return (
    <ShapeShell summary={shape.summary}>
      <div className="flex min-w-0 flex-col gap-1.5 px-3 py-2.5">
        <div className="flex min-w-0 items-baseline gap-3">
          <span className="min-w-0 flex-1 truncate font-display text-[13px] font-semibold leading-snug">
            {shape.title}
          </span>
          <ActionBar rowKey={shape.boardId} actions={shape.actions} />
        </div>
        {shape.columns.length ? (
          <ul className="flex flex-wrap gap-x-3 gap-y-1">
            {shape.columns.map((column) => (
              <li
                key={column.name}
                className="flex items-baseline gap-1.5 text-[12px] text-[var(--color-text-muted)]"
              >
                <span>{column.name}</span>
                <span className="tabular-nums text-[var(--color-text-faint)]">{column.count}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </ShapeShell>
  );
}
