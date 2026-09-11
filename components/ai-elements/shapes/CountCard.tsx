'use client';

import type { ToolShape } from '@/lib/ai/tool-shapes';
import { formatCount } from '@/lib/chat/shape-format';
import { ShapeShell } from './shape-shell';

export function CountCard({ shape }: { shape: Extract<ToolShape, { kind: 'count' }> }) {
  return (
    <ShapeShell>
      <div className="flex min-w-0 items-baseline gap-3 px-3 py-2.5">
        <span className="font-display text-[26px] font-semibold leading-none tabular-nums text-[var(--color-text)]">
          {formatCount(shape.value)}
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-[12.5px] font-medium leading-snug">{shape.label}</span>
          {shape.summary ? (
            <span className="truncate text-[11.5px] text-[var(--color-text-muted)]">{shape.summary}</span>
          ) : null}
        </span>
      </div>
    </ShapeShell>
  );
}
