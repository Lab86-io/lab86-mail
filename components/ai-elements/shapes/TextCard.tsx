'use client';

import type { ToolShape } from '@/lib/ai/tool-shapes';
import { ShapeShell } from './shape-shell';

export function TextCard({ shape }: { shape: Extract<ToolShape, { kind: 'text' }> }) {
  return (
    <ShapeShell>
      <p className="px-3 py-2.5 text-[12px] leading-relaxed text-[var(--color-text-muted)]">{shape.text}</p>
    </ShapeShell>
  );
}
