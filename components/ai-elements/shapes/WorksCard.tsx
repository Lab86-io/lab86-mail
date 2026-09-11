'use client';

import type { ToolShape } from '@/lib/ai/tool-shapes';
import { formatProgress } from '@/lib/chat/shape-format';
import { ShapeList, ShapeRow, ShapeShell } from './shape-shell';

export function WorksCard({ shape }: { shape: Extract<ToolShape, { kind: 'works' }> }) {
  return (
    <ShapeShell title={shape.title} summary={shape.summary}>
      <ShapeList>
        {shape.items.map((item) => (
          <ShapeRow
            key={item.workId}
            rowKey={item.workId}
            primary={item.title}
            meta={formatProgress(item.progress) || item.status}
            secondary={item.currentStep || [item.shape, item.horizon].filter(Boolean).join(' · ')}
            actions={item.actions}
          />
        ))}
      </ShapeList>
    </ShapeShell>
  );
}
