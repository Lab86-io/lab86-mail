'use client';

import type { ToolShape } from '@/lib/ai/tool-shapes';
import { ActionBar, Facts, ShapeShell } from './shape-shell';

export function AreaCard({ shape }: { shape: Extract<ToolShape, { kind: 'area' }> }) {
  return (
    <ShapeShell summary={shape.summary}>
      <div className="flex min-w-0 flex-col gap-1 px-3 py-2.5">
        <div className="flex min-w-0 items-baseline gap-3">
          <span className="min-w-0 flex-1 truncate font-display text-[13px] font-semibold leading-snug">
            {shape.name}
          </span>
          <ActionBar rowKey={shape.areaId} actions={shape.actions} />
        </div>
        <Facts items={[shape.areaKind, shape.domain]} />
        {shape.description ? (
          <p className="line-clamp-3 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
            {shape.description}
          </p>
        ) : null}
      </div>
    </ShapeShell>
  );
}
