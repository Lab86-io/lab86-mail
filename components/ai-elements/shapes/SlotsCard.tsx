'use client';

import type { ToolShape } from '@/lib/ai/tool-shapes';
import { formatEventSpan } from '@/lib/chat/shape-format';
import { ShapeList, ShapeRow, ShapeShell } from './shape-shell';

export function SlotsCard({ shape }: { shape: Extract<ToolShape, { kind: 'slots' }> }) {
  return (
    <ShapeShell title={shape.title} summary={shape.summary}>
      <ShapeList>
        {shape.items.map((item) => (
          <ShapeRow
            key={`${item.startIso}-${item.endIso}`}
            rowKey={`${item.startIso}-${item.endIso}`}
            primary={formatEventSpan(item.startIso, item.endIso)}
            actions={item.actions}
          />
        ))}
      </ShapeList>
    </ShapeShell>
  );
}
